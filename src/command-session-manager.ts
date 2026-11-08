import {
  ExecutorCommandRunArgumentsSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { startGuestVmSession, type GuestVmSession, type GuestVmSessionInput } from './guest-vm-session.js'
import {
  createGuestWorkspaceLease,
  guestSessionFolder,
  releaseGuestWorkspaceLeaseIfCurrent,
  type GuestWorkspaceLease,
} from './guest-workspace-lease.js'
import type { ExecutorGuestVmExecutionConfig } from './state-store.js'
import { localCommandPolicyPermits, type LocalCommandPolicy } from './command-policy.js'

const COMMAND_SESSION_MAX_MS = 10 * 60 * 1_000
const COMMAND_RESULT_MAX_BYTES = 8_192
const COMMAND_RUNTIME_MAX_SECONDS = 300

type ActiveCommandSession = {
  session: GuestVmSession
  stopTimer: NodeJS.Timeout
}

type OpeningCommandSession = {
  cancelled: boolean
  completed: Promise<void>
  finish: () => void
}

type CommandSessionStarter = (input: GuestVmSessionInput) => Promise<GuestVmSession>
type PreparedLeaseSource = {
  release: () => Promise<void>
  workspaceRoot: string
}

export type ExecutorCommandSessionManager = {
  isIdle: () => boolean
  /** `rules`: the rules this one launch runs under, when the owner allowed it once; the saved ones otherwise. */
  run: (command: ExecutorCommandEnvelope, runId: string, rules?: LocalCommandPolicy) => Promise<Record<string, unknown>>
  stop: (runId: string) => Promise<boolean>
  stopAll: () => Promise<void>
}

const unavailable = (): Record<string, unknown> => ({ code: 'EXECUTOR_COMMAND_UNAVAILABLE', success: false })
const denied = (): Record<string, unknown> => ({ code: 'EXECUTOR_COMMAND_DENIED', success: false })

/**
 * Owns a network-disabled, lease-bound command VM per run. It deliberately
 * reuses the browser VM artifact configuration but omits egress altogether;
 * the command guest receives no proxy, no Codex auth profile, and no host path
 * other than the daemon-created COW workspace.
 */
export const createExecutorCommandSessionManager = (
  stateDir: string,
  state: ExecutorGuestVmExecutionConfig,
  dependencies: {
    prepareLeaseSource?: (command: ExecutorCommandEnvelope) => Promise<PreparedLeaseSource>
    startSession?: CommandSessionStarter
    verifyLease?: (lease: GuestWorkspaceLease, command: ExecutorCommandEnvelope) => Promise<boolean>
  } = {},
): ExecutorCommandSessionManager => {
  const activeByRun = new Map<string, ActiveCommandSession>()
  const openingByRun = new Map<string, OpeningCommandSession>()
  const startedRunIds = new Set<string>()
  const startSession = dependencies.startSession ?? startGuestVmSession

  const clear = (runId: string, active: ActiveCommandSession): void => {
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

  const start = async (command: ExecutorCommandEnvelope, runId: string): Promise<GuestVmSession | null> => {
    const sandbox = state.browserSandbox
    if (!sandbox || startedRunIds.has(runId)) return null
    const maxSessions = state.descriptor.limits.maxSessions
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || activeByRun.size + openingByRun.size >= maxSessions) {
      return null
    }
    startedRunIds.add(runId)
    let resolveOpening: (() => void) | undefined
    const opening: OpeningCommandSession = {
      cancelled: false,
      completed: new Promise<void>((resolve) => { resolveOpening = resolve }),
      finish: () => resolveOpening?.(),
    }
    openingByRun.set(runId, opening)
    let lease: Awaited<ReturnType<typeof createGuestWorkspaceLease>> | undefined
    let prepared: PreparedLeaseSource | undefined
    let session: GuestVmSession | undefined
    const stopSessionAndReleaseLease = async (): Promise<void> => {
      try {
        await session?.stop()
      } finally {
        if (lease) await releaseGuestWorkspaceLeaseIfCurrent(stateDir, lease)
      }
    }
    try {
      prepared = await dependencies.prepareLeaseSource?.(command)
      lease = await createGuestWorkspaceLease(
        stateDir,
        // Refuses when more than one folder is configured; the daemon dispatch
        // has already answered with the named reason before reaching here.
        guestSessionFolder(state.workspaceFolders, prepared?.workspaceRoot),
        { bindingFence: command.bindingFence, commandId: command.commandId, runId },
      )
      await prepared?.release()
      prepared = undefined
      if (opening.cancelled) {
        await stopSessionAndReleaseLease()
        return null
      }
      if (dependencies.verifyLease && !(await dependencies.verifyLease(lease, command))) {
        await stopSessionAndReleaseLease()
        return null
      }
      if (opening.cancelled) {
        await stopSessionAndReleaseLease()
        return null
      }
      session = await startSession({
        guestInitrdBuilderPath: sandbox.guestInitrdBuilderPath,
        guestRuntimeBundlePath: sandbox.guestRuntimeBundlePath,
        kernelPath: sandbox.kernelPath,
        lease,
        stateDir,
        vmHelperPath: sandbox.vmHelperPath,
      })
      if (opening.cancelled || !(await session.inspectRuntime()).codex) {
        await stopSessionAndReleaseLease()
        return null
      }
    } catch {
      await stopSessionAndReleaseLease().catch(() => undefined)
      return null
    } finally {
      await prepared?.release().catch(() => undefined)
      if (openingByRun.get(runId) === opening) openingByRun.delete(runId)
      opening.finish()
    }
    if (!session || opening.cancelled) {
      await stopSessionAndReleaseLease().catch(() => undefined)
      return null
    }
    const active: ActiveCommandSession = {
      session,
      stopTimer: setTimeout(() => { void stop(runId).catch(() => undefined) }, COMMAND_SESSION_MAX_MS),
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
      return null
    }
    return session
  }

  return {
    isIdle: () => activeByRun.size === 0 && openingByRun.size === 0,
    run: async (command, runId, rules) => {
      const args = ExecutorCommandRunArgumentsSchema.safeParse(command.payload.args)
      if (!args.success) return denied()
      // The allowlist decides before a guest exists, so a program nobody
      // permitted cannot even cost a VM boot. This is the one path both the
      // control plane and the DeepTest execution adapter reach, which is why
      // the decision lives here rather than only at the daemon's dispatch.
      if (!localCommandPolicyPermits(
        rules ? { ...state, commandPolicy: rules } : state,
        args.data.program,
        args.data.args,
      )) {
        return denied()
      }
      let active = activeByRun.get(runId)
      if (!active) {
        const session = await start(command, runId)
        active = session ? activeByRun.get(runId) : undefined
      }
      if (!active) return unavailable()
      const maxResultBytes = Math.min(state.descriptor.limits.maxResultBytes, COMMAND_RESULT_MAX_BYTES)
      const runtimeSeconds = Math.min(state.descriptor.limits.maxCommandRuntimeSeconds, COMMAND_RUNTIME_MAX_SECONDS)
      if (maxResultBytes < 1 || runtimeSeconds < 1) return unavailable()
      try {
        return await active.session.runCommand({
          args: args.data.args,
          ...(args.data.cwd ? { cwd: args.data.cwd } : {}),
          maxResultBytes,
          program: args.data.program,
          runtimeSeconds,
        })
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
