import { canonicalExecutorJson } from '@nessie/executor-protocol'

import { executorApi, ExecutorApiError, type ExecutorApiClient } from './api-client.js'
import type { DaemonLiveState } from './daemon-live-state.js'
import { signedDescriptorForState } from './pair.js'
import { loadExecutorState, saveExecutorState, type ExecutorLocalState } from './state-store.js'

/**
 * Live apply: a policy saved while the daemon runs takes effect without a
 * restart and without a new connection.
 *
 * `reload` reads the saved state, keeps the daemon's own connection epoch, and
 * swaps it in, so the next command is checked against it — a narrowed rule
 * holds from that moment, before Nessie has heard anything. It then signs the
 * saved revision and submits it under the current connection epoch, which
 * Nessie accepts from a connected daemon; a command Nessie signed against the
 * earlier revision is refused as `EXECUTOR_DESCRIPTOR_STALE`, as after any
 * restart. A submission that fails is retried (`retry`, on every heartbeat)
 * until Nessie has the revision the daemon enforces.
 *
 * Nessie never holds two policies under one revision. When it already has this
 * revision number with different content — the facts detected at signing can
 * change without a policy change — the daemon saves the next revision through
 * the same compare-and-set writer, exactly as a claim does, and submits that.
 * The daemon writes nothing else: the owner's commands remain the writers.
 */
export type DaemonLiveApply = {
  /** Reads the saved state; true when the daemon now enforces something it did not before. */
  reload: () => Promise<boolean>
  /** Submits the enforced revision if Nessie has not acknowledged it yet. */
  retry: () => Promise<void>
  /** A claim submitted the current revision itself. */
  submitted: () => void
}

type Dependencies = {
  api: Pick<ExecutorApiClient, 'submitDescriptor'>
  loadState: typeof loadExecutorState
  saveState: typeof saveExecutorState
  log: (message: string) => void
}

const comparable = (state: ExecutorLocalState): string => canonicalExecutorJson(state)

export const createDaemonLiveApply = (
  stateDir: string,
  live: DaemonLiveState,
  dependencies: Dependencies = {
    api: executorApi, loadState: loadExecutorState, saveState: saveExecutorState,
    log: (message) => { console.error(`[nessie-executor] ${message}`) },
  },
): DaemonLiveApply => {
  let due = false
  let running: Promise<void> | null = null

  const submit = async (): Promise<void> => {
    const state = live.current
    if (!state.connectionEpoch) return
    const send = (descriptorState: ExecutorLocalState) => dependencies.api.submitDescriptor(descriptorState.apiBaseUrl, {
      connectionEpoch: state.connectionEpoch!, descriptor: signedDescriptorForState(descriptorState),
      executorId: descriptorState.executorId,
    })
    try {
      await send(state)
      if (live.current === state) due = false
    } catch (error) {
      if (!(error instanceof ExecutorApiError) || error.code !== 'EXECUTOR_DESCRIPTOR_REVISION_CONFLICT') {
        dependencies.log(`revision ${state.descriptor.revision} is enforced here and not yet in Nessie: `
          + (error instanceof Error ? error.message : String(error)))
        return
      }
      const persisted = await dependencies.loadState(stateDir)
      // Another save landed meanwhile; the watch reloads it and submits that.
      if (persisted.descriptor.revision !== state.descriptor.revision) return
      const next = { ...persisted, descriptor: { ...persisted.descriptor, revision: persisted.descriptor.revision + 1 } }
      await dependencies.saveState(stateDir, next, persisted)
      live.set({ ...next, ...(state.connectionEpoch ? { connectionEpoch: state.connectionEpoch } : {}) })
      await send(live.current)
      due = false
    }
  }

  const serially = (work: () => Promise<void>): Promise<void> => {
    const run = (running ?? Promise.resolve()).then(work, work)
    running = run.catch(() => undefined).then(() => { if (running === run) running = null })
    return run
  }

  return {
    reload: async () => {
      let changed = false
      await serially(async () => {
        const current = live.current
        let persisted: ExecutorLocalState
        try {
          persisted = await dependencies.loadState(stateDir)
        } catch (error) {
          // Our writers replace the file atomically, so this is damage; the
          // daemon keeps enforcing what it last read rather than guessing.
          dependencies.log(`saved state could not be read and was not applied: ${
            error instanceof Error ? error.message : String(error)}`)
          return
        }
        const next: ExecutorLocalState = { ...persisted }
        // The daemon's connection is its own; a claim another process made is not adopted here.
        if (current.connectionEpoch) next.connectionEpoch = current.connectionEpoch
        else delete next.connectionEpoch
        if (comparable(next) === comparable(current)) return
        live.set(next)
        changed = true
        // Folder paths, launch specs and command rules stay local; only a changed descriptor is news to Nessie.
        if (canonicalExecutorJson(next.descriptor) !== canonicalExecutorJson(current.descriptor)) {
          due = true
          await submit()
        }
      })
      return changed
    },
    retry: () => serially(async () => { if (due) await submit() }),
    submitted: () => { due = false },
  }
}
