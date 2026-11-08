import * as Effect from 'effect/Effect'
import { CommandLineage } from '@nessie/t3-session-source/engine'
import type { T3ExecutionBinding } from '@nessie/executor-protocol/t3-session'
import { makeSessionLaunchCommandLineage, type SessionLaunchCommandLineage,
  type SessionProviderTurnStartEffect } from './command-lineage.js'

export interface SessionCommandLineageRegistry {
  readonly service: CommandLineage.SessionCommandLineage['Service']
  register(binding: Pick<T3ExecutionBinding, 'commandId' | 'threadId'>, recheck: () => Promise<void>,
    parent: AbortSignal): SessionLaunchCommandLineage
  /** Finds the recorded predecessor; returning an owner supplies no claim permission. */
  recognizeProviderTurnStart(effect: SessionProviderTurnStartEffect):
    Effect.Effect<SessionLaunchCommandLineage, CommandLineage.SessionCommandLineageError>
  close(): void
}

/** The original launch layer is memoized across commands in the same source
 * graph. Route by its actual parent command, never a current/latest operation.
 * Retired command IDs stay burned for this owner; a new recorder cannot renew
 * a cancelled reservation. No entry in this registry authorizes an effect. */
export function makeSessionCommandLineageRegistry(signal: AbortSignal): SessionCommandLineageRegistry {
  const entries = new Map<string, SessionLaunchCommandLineage | undefined>()
  const releaseCommands = new Map<string, { readonly parentCommandId: string; readonly accepted: boolean }>()
  let live = true
  const refused = () => new CommandLineage.SessionCommandLineageError()
  const close = () => {
    live = false
    for (const owner of entries.values()) owner?.close()
    entries.clear()
    releaseCommands.clear()
    signal.removeEventListener('abort', close)
  }
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) close()
  return Object.freeze<SessionCommandLineageRegistry>({
    service: CommandLineage.SessionCommandLineage.of({ recordInitialMessage: edge => Effect.suspend(() => {
      const owner = live && !signal.aborted ? entries.get(edge.parentCommandId) : undefined
      return owner ? owner.service.recordInitialMessage(edge) : Effect.fail(refused())
    }), recordInitialMessageRun: edge => Effect.suspend(() => {
      const owner = live && !signal.aborted ? entries.get(edge.parentCommandId) : undefined
      return owner ? owner.service.recordInitialMessageRun(edge) : Effect.fail(refused())
    }), recordPreparedRunRelease: edge => Effect.gen(function* () {
      const captured = Object.freeze({ parentCommandId: edge.parentCommandId, commandId: edge.commandId,
        threadId: edge.threadId, runId: edge.runId })
      const owner = live && !signal.aborted ? entries.get(captured.parentCommandId) : undefined
      if (!owner) return yield* Effect.fail(refused())
      yield* owner.service.recordPreparedRunRelease(captured)
      if (!live || signal.aborted || entries.get(captured.parentCommandId) !== owner) {
        return yield* Effect.fail(refused())
      }
      const existing = releaseCommands.get(captured.commandId)
      if (existing !== undefined && existing.parentCommandId !== captured.parentCommandId) {
        owner.close()
        return yield* Effect.fail(refused())
      }
      if (existing === undefined) releaseCommands.set(captured.commandId,
        Object.freeze({ parentCommandId: captured.parentCommandId, accepted: false }))
    }), recordPreparedRunReleased: edge => Effect.gen(function* () {
      const captured = Object.freeze({ parentCommandId: edge.parentCommandId, commandId: edge.commandId,
        threadId: edge.threadId, runId: edge.runId })
      const owner = live && !signal.aborted ? entries.get(captured.parentCommandId) : undefined
      const existing = releaseCommands.get(captured.commandId)
      if (!owner || existing?.parentCommandId !== captured.parentCommandId) return yield* Effect.fail(refused())
      yield* owner.service.recordPreparedRunReleased(captured)
      if (!live || signal.aborted || entries.get(captured.parentCommandId) !== owner) {
        return yield* Effect.fail(refused())
      }
      releaseCommands.set(captured.commandId,
        Object.freeze({ parentCommandId: captured.parentCommandId, accepted: true }))
    }) }),
    recognizeProviderTurnStart: effect => Effect.suspend(() => {
      const observed = releaseCommands.get(effect.commandId)
      const parentCommandId = observed?.accepted ? observed.parentCommandId : undefined
      const owner = live && !signal.aborted && parentCommandId !== undefined ? entries.get(parentCommandId) : undefined
      return owner ? owner.assertProviderTurnStart(effect).pipe(Effect.as(owner)) : Effect.fail(refused())
    }),
    register: (binding, recheck, parent) => {
      const commandId = binding.commandId
      // The fixed source control channel also bounds all call IDs to 4096.
      if (!live || signal.aborted || parent.aborted || !commandId || !binding.threadId
        || entries.has(commandId) || entries.size >= 4096) throw refused()
      const owner = makeSessionLaunchCommandLineage(binding, recheck, AbortSignal.any([signal, parent]))
      const registered = Object.freeze<SessionLaunchCommandLineage>({ ...owner, close: () => {
        owner.close()
        if (live) entries.set(commandId, undefined)
      } })
      entries.set(commandId, registered)
      return registered
    },
    close,
  })
}
