import {
  ExecutorCodingLaunchArgumentsSchema,
  ExecutorCodingObserveArgumentsSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { startGuestVmSession, type GuestVmSession, type GuestVmSessionInput } from './guest-vm-session.js'
import {
  createGuestWorkspaceLease,
  guestSessionFolder,
  releaseGuestWorkspaceLeaseIfCurrent,
} from './guest-workspace-lease.js'
import type { ExecutorLocalState } from './state-store.js'

const CODING_SESSION_MAX_MS = 20 * 60 * 1_000

// ChatGPT-backed Codex uses this one provider origin. A model task cannot
// supply an origin, and the guest has no direct network/DNS route.
export const CODEX_EGRESS_ORIGINS = ['https://chatgpt.com'] as const

type ActiveCodingSession = {
  session: GuestVmSession
  stopTimer: NodeJS.Timeout
}

type OpeningCodingSession = {
  cancelled: boolean
  completed: Promise<void>
  finish: () => void
}

type CodingSessionStarter = (input: GuestVmSessionInput) => Promise<GuestVmSession>

export type ExecutorCodingSessionManager = {
  launch: (command: ExecutorCommandEnvelope, runId: string) => Promise<Record<string, unknown>>
  observe: (command: ExecutorCommandEnvelope, runId: string) => Promise<Record<string, unknown>>
  stop: (runId: string) => Promise<boolean>
  stopAll: () => Promise<void>
}

const unavailable = (): Record<string, unknown> => ({ code: 'EXECUTOR_CODING_UNAVAILABLE', success: false })
const denied = (): Record<string, unknown> => ({ code: 'EXECUTOR_CODING_DENIED', success: false })

/**
 * Owns one credential-bearing Codex guest per run. The only server-visible
 * observation is typed lifecycle state; the tmux pane and its raw output stay
 * inside the guest. VM exit, stop, timer expiry, and daemon fencing erase the
 * transient initrd/auth home alongside the exact COW lease.
 */
export const createExecutorCodingSessionManager = (
  stateDir: string,
  state: ExecutorLocalState,
  dependencies: { startSession?: CodingSessionStarter } = {},
): ExecutorCodingSessionManager => {
  const activeByRun = new Map<string, ActiveCodingSession>()
  const openingByRun = new Map<string, OpeningCodingSession>()
  const launchedRunIds = new Set<string>()
  const startSession = dependencies.startSession ?? startGuestVmSession

  const clear = (runId: string, active: ActiveCodingSession): void => {
    if (activeByRun.get(runId) !== active) return
    clearTimeout(active.stopTimer)
    activeByRun.delete(runId)
  }

  const stop = async (runId: string): Promise<boolean> => {
    const opening = openingByRun.get(runId)
    if (opening) opening.cancelled = true
    const active = activeByRun.get(runId)
    if (!active) return Boolean(opening)
    await active.session.stop()
    clear(runId, active)
    return true
  }

  return {
    launch: async (command, runId) => {
      const sandbox = state.codexSandbox
      const args = ExecutorCodingLaunchArgumentsSchema.safeParse(command.payload.args)
      if (!args.success) return denied()
      if (!sandbox) return unavailable()
      if (launchedRunIds.has(runId)) return { code: 'EXECUTOR_CODING_SESSION_USED', success: false }
      const maxSessions = state.descriptor.limits.maxSessions
      if (!Number.isInteger(maxSessions) || maxSessions < 1) return unavailable()
      if (activeByRun.size + openingByRun.size >= maxSessions) {
        return { code: 'EXECUTOR_CODING_CAPACITY_REACHED', success: false }
      }
      launchedRunIds.add(runId)
      let resolveOpening: (() => void) | undefined
      const opening: OpeningCodingSession = {
        cancelled: false,
        completed: new Promise<void>((resolve) => { resolveOpening = resolve }),
        finish: () => resolveOpening?.(),
      }
      openingByRun.set(runId, opening)
      let lease: Awaited<ReturnType<typeof createGuestWorkspaceLease>> | undefined
      let session: GuestVmSession | undefined
      const stopSessionAndReleaseLease = async (): Promise<void> => {
        try {
          await session?.stop()
        } finally {
          if (lease) await releaseGuestWorkspaceLeaseIfCurrent(stateDir, lease)
        }
      }
      try {
        lease = await createGuestWorkspaceLease(
          stateDir,
          // Refuses when more than one folder is configured; the daemon dispatch
          // has already answered with the named reason before reaching here.
          guestSessionFolder(state.workspaceFolders),
          { bindingFence: command.bindingFence, commandId: command.commandId, runId },
        )
        session = await startSession({
          codexAuthProfilePath: sandbox.codexAuthProfilePath,
          egressPolicy: { allowedOrigins: [...CODEX_EGRESS_ORIGINS] },
          guestInitrdBuilderPath: sandbox.guestInitrdBuilderPath,
          guestRuntimeBundlePath: sandbox.guestRuntimeBundlePath,
          kernelPath: sandbox.kernelPath,
          lease,
          stateDir,
          vmHelperPath: sandbox.vmHelperPath,
        })
        const inspection = await session.inspectRuntime()
        if (opening.cancelled || !inspection.codex || !inspection.tmux) {
          await stopSessionAndReleaseLease()
          return unavailable()
        }
        await session.launchCodingSession('codex', args.data.prompt)
      } catch {
        await stopSessionAndReleaseLease().catch(() => undefined)
        return unavailable()
      } finally {
        if (openingByRun.get(runId) === opening) openingByRun.delete(runId)
        opening.finish()
      }
      if (!session || opening.cancelled) {
        await stopSessionAndReleaseLease().catch(() => undefined)
        return unavailable()
      }
      const active: ActiveCodingSession = {
        session,
        stopTimer: setTimeout(() => { void stop(runId).catch(() => undefined) }, CODING_SESSION_MAX_MS),
      }
      activeByRun.set(runId, active)
      void session.closed
        .finally(async () => {
          clear(runId, active)
          if (lease) await releaseGuestWorkspaceLeaseIfCurrent(stateDir, lease)
        })
        .catch(() => undefined)
      if (opening.cancelled) {
        await stop(runId).catch(() => undefined)
        return unavailable()
      }
      return { status: 'started', success: true }
    },
    observe: async (command, runId) => {
      if (!ExecutorCodingObserveArgumentsSchema.safeParse(command.payload.args).success) return denied()
      const active = activeByRun.get(runId)
      if (!active) return unavailable()
      try {
        const observation = await active.session.observeCodingSession()
        return {
          agent: observation.agent,
          ...(observation.exitStatus === undefined ? {} : { exitStatus: observation.exitStatus }),
          lifecycle: observation.lifecycle,
          success: true,
        }
      } catch {
        return unavailable()
      }
    },
    stop,
    stopAll: async () => {
      const opening = [...openingByRun.entries()]
      for (const [, entry] of opening) entry.cancelled = true
      await Promise.allSettled([
        ...[...activeByRun.keys()].map((runId) => stop(runId)),
        ...opening.map(([, entry]) => entry.completed),
      ])
    },
  }
}
