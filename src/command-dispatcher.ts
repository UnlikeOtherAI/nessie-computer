import {
  EXECUTOR_ACTIVE_COMMANDS_MAXIMUM,
  EXECUTOR_COMMAND_CANCELLED_RESULT,
  EXECUTOR_COMMAND_CAPACITY_KINDS,
  type ExecutorCommandCancellation,
  type ExecutorCommandCancellationTarget,
  type ExecutorCommandCapacity,
  type ExecutorCommandCapacityKind,
  type ExecutorCommandEnvelope,
  type ExecutorCommandWait,
  type ExecutorSessionClose,
  type ExecutorSessionId,
} from '@nessie/executor-protocol'

import { cancellationNames, cancellationTargetOf, runCancellable } from './command-cancellation.js'
import type { ExecutorCommandJournal, ExecutorCommandRecord } from './command-journal.js'
import { createCommandQueue } from './command-queue.js'
import {
  advanceExecutorCommand,
  type ExecutorCommandAdmission,
  type ExecutorCommandReceiptSender,
  type ExecutorCommandRecoveryAttachments,
} from './command-recovery.js'
import {
  COMPUTER_COMMAND_LIMITS, NO_CAPACITY, SESSION_COMMAND_LIMITS, commandKind, commandResources, freeCapacity,
} from './command-resources.js'
import { sessionCommandView } from './session-command-view.js'
import type { SessionCommandStatus, SessionView } from './session-snapshot.js'
import { createSessionTracker, EXECUTOR_SESSION_STOPPED_RESULT, sessionKeyOf } from './session-tracker.js'

/**
 * Runs every command the daemon holds side by side (contract §11.2). Each
 * command advances through its own journal record and receipts
 * (`command-recovery.ts`); it starts once its kind has a slot and its
 * resources are free (`command-queue.ts`); and it can be ended on its own —
 * Nessie's cancellation, the owner's Stop of its session, Nessie closing the
 * session — without touching any other command.
 *
 * Nessie that hands out one command at a time gets the `single` mode: one
 * command runs at a time, and each watches its own cancellation the old way.
 */

/** How a command that may ask the owner gives back its slot while it waits, and takes one again. */
export type OwnerWait = {
  /** The owner was asked (`requestId` is the program request); the command holds no slot meanwhile. */
  begin: (requestId: string) => void
  /** The owner answered or the wait ended; an allowed launch waits for a slot again before it runs. */
  end: (allowed: boolean) => Promise<void>
}

export type CommandContext = { signal: AbortSignal; ownerWait: OwnerWait }

export type CommandDispatcherMode = 'concurrent' | 'single'

export type CommandDispatcherOptions = {
  journal: ExecutorCommandJournal
  receipt: ExecutorCommandReceiptSender
  attachments?: ExecutorCommandRecoveryAttachments
  onResultRefused?: (command: ExecutorCommandEnvelope) => void
  execute: (command: ExecutorCommandEnvelope, context: CommandContext) => Promise<Record<string, unknown>>
  /** Tears down the backend an ended command owns. */
  cancelBackend: (command: ExecutorCommandEnvelope) => Promise<void>
  /** Ends a run's sandboxes, browsers and coding work, when its session ends. */
  endRun: (runId: string) => Promise<void>
  /** The old cancellation watch, for `single` mode. */
  legacyCancelWatch?: (
    command: ExecutorCommandEnvelope, onCancel: () => void,
  ) => { first: Promise<void>; stop: () => void }
  /** The coding-sessions bridge's server name, which decides what a terminal is. */
  bridge: () => string | undefined
  paused: () => boolean
  /** Anything the poll or the owner's list shows changed. */
  onChange: () => void
  /** Nessie closed a session; the owner's stop of it, if any, is done. */
  onSessionClosed?: (sessionId: string) => void
  log?: (message: string) => void
  now?: () => Date
}

type Entry = {
  record: ExecutorCommandRecord
  controller: AbortController
  /** The result it ends with, once it is ended before or while it runs. */
  ending?: Record<string, unknown>
  release?: () => void
  queued: boolean
  ownerRequest?: string
  task?: Promise<void>
  attempts: number
  retry?: NodeJS.Timeout
}

const RETRY_FIRST_MS = 1_000
const OWNER_GONE_RESULT = Object.freeze({
  code: 'EXECUTOR_COMMAND_DENIED',
  message: 'The computer stopped before its owner answered the request to run this program.',
  reason: 'owner_did_not_answer',
  success: false,
})
const RETRY_LAST_MS = 30_000

export const createCommandDispatcher = (options: CommandDispatcherOptions) => {
  const log = options.log ?? ((message: string) => { console.error(`[nessie-executor] ${message}`) })
  const now = options.now ?? (() => new Date())
  const entries = new Map<string, Entry>()
  const sessions = createSessionTracker()
  const sites = new Map<string, string>()
  let mode: CommandDispatcherMode = 'concurrent'
  let closing = false
  const queue = createCommandQueue({
    computer: () => COMPUTER_COMMAND_LIMITS,
    session: SESSION_COMMAND_LIMITS,
    total: () => (mode === 'single' ? 1 : Number.POSITIVE_INFINITY),
  })
  const changed = (): void => { if (!closing) options.onChange() }

  const releaseSlot = (entry: Entry): void => {
    const release = entry.release
    entry.release = undefined
    release?.()
  }

  const takeSlot = async (entry: Entry): Promise<boolean> => {
    // A closing daemon starts nothing; the record resumes after the restart.
    if (closing) await new Promise<never>(() => undefined)
    const { command } = entry.record
    entry.queued = true
    changed()
    const release = await queue.acquire({
      kind: commandKind(command), session: sessionKeyOf(command),
      resources: commandResources(command, options.bridge()), signal: entry.controller.signal,
    })
    entry.queued = false
    if (!release) return false
    entry.release = release
    changed()
    return true
  }

  const admit = async (entry: Entry): Promise<ExecutorCommandAdmission> => {
    if (entry.ending) return { result: entry.ending }
    if (!await takeSlot(entry)) return { result: entry.ending ?? { ...EXECUTOR_COMMAND_CANCELLED_RESULT } }
    return { release: () => releaseSlot(entry) }
  }

  const ownerWaitOf = (entry: Entry): OwnerWait => ({
    begin: (requestId) => {
      entry.ownerRequest = requestId
      releaseSlot(entry)
      changed()
    },
    end: async (allowed) => {
      entry.ownerRequest = undefined
      changed()
      if (!allowed) return
      if (!await takeSlot(entry)) entry.controller.signal.throwIfAborted()
    },
  })

  const execute = async (entry: Entry): Promise<Record<string, unknown>> => {
    const { command } = entry.record
    if (command.operationKey === 'browser.open' && typeof command.payload.args === 'object') {
      const url = (command.payload.args as { url?: unknown }).url
      try { if (typeof url === 'string') sites.set(String(command.payload.runId), new URL(url).hostname) } catch { /* no site */ }
    }
    const watch = mode === 'single' ? options.legacyCancelWatch?.(command, () => end(entry, undefined)) : undefined
    try {
      await watch?.first
      return await runCancellable({
        controller: entry.controller,
        cancel: () => options.cancelBackend(command),
        cancelled: () => entry.ending ?? { ...EXECUTOR_COMMAND_CANCELLED_RESULT },
        execute: (signal) => options.execute(command, { signal, ownerWait: ownerWaitOf(entry) }),
      })
    } finally {
      watch?.stop()
    }
  }

  const drive = (entry: Entry): void => {
    if (entry.task || closing) return
    entry.task = advanceExecutorCommand(entry.record, {
      journal: options.journal,
      receipt: options.receipt,
      ...(options.attachments ? { attachments: options.attachments } : {}),
      ...(options.onResultRefused ? { onResultRefused: options.onResultRefused } : {}),
      onPhase: (record) => {
        entry.record = record
        changed()
      },
      admit: () => admit(entry),
      execute: () => execute(entry),
      now,
    }).then(() => {
      entries.delete(entry.record.command.commandId)
      sessions.forget(sessionKeyOf(entry.record.command))
      changed()
    }, (error: unknown) => {
      entry.attempts += 1
      log(`command ${entry.record.command.commandId} will be reported again: ${error instanceof Error ? error.message : String(error)}`)
      if (closing) return
      const delay = Math.min(RETRY_FIRST_MS * 2 ** (entry.attempts - 1), RETRY_LAST_MS)
      entry.retry = setTimeout(() => {
        entry.retry = undefined
        drive(entry)
      }, delay)
      entry.retry.unref()
    }).finally(() => {
      entry.task = undefined
    })
  }

  /** Ends one held command: before it starts it never runs, and while it runs its backend stops. */
  const end = (entry: Entry, result: Record<string, unknown> | undefined): void => {
    if (entry.record.phase === 'result_pending') return
    entry.ending ??= result ?? { ...EXECUTOR_COMMAND_CANCELLED_RESULT }
    entry.controller.abort()
    queue.pump()
  }

  const hold = (record: ExecutorCommandRecord): void => {
    const entry: Entry = { attempts: 0, controller: new AbortController(), queued: false, record }
    const refusal = sessions.refusal(record.command)
    if (refusal) entry.ending = refusal
    entries.set(record.command.commandId, entry)
    sessions.note(record.command, record.receivedAt)
    drive(entry)
  }

  const inSession = (sessionId: string): Entry[] =>
    [...entries.values()].filter((entry) => sessionKeyOf(entry.record.command) === sessionId)

  const endRuns = (runIds: readonly string[]): void => {
    for (const runId of runIds) {
      sites.delete(runId)
      void options.endRun(runId).catch((error: unknown) => {
        log(`run ${runId} was not ended: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  const statusOf = (entry: Entry): SessionCommandStatus => {
    if (entry.ownerRequest) return 'waiting_for_owner'
    if (entry.release || entry.record.phase === 'result_pending') return 'running'
    return entry.record.phase === 'executing' && !entry.queued ? 'running' : 'queued'
  }

  const occupies = (entry: Entry): boolean => !entry.ownerRequest && entry.record.phase !== 'result_pending'

  return {
    /** Takes up every command the journal still holds, from before a restart. */
    start: async (): Promise<void> => {
      for (const record of await options.journal.list()) {
        if (!entries.has(record.command.commandId)) hold(record)
      }
      changed()
    },
    /** New commands from a poll. A command already held is the same delivery again and is ignored. */
    accept: async (commands: readonly ExecutorCommandEnvelope[]): Promise<void> => {
      const fresh = commands.filter((command, index) => !entries.has(command.commandId)
        && commands.findIndex((other) => other.commandId === command.commandId) === index)
      const receivedAt = now().toISOString()
      const records = fresh.map((command): ExecutorCommandRecord => ({
        command, phase: 'accepted_pending', receivedAt, version: 2,
      }))
      // Journaled before anything is acknowledged: a crash first means Nessie delivers it again.
      await Promise.all(records.map((record) => options.journal.save(record)))
      for (const record of records) hold(record)
      if (records.length) changed()
    },
    cancel: (cancellations: readonly ExecutorCommandCancellation[]): void => {
      for (const cancellation of cancellations) {
        const entry = entries.get(cancellation.commandId)
        if (entry && cancellationNames(cancellation, entry.record.command)) end(entry, undefined)
      }
    },
    /** The owner stopped a session on this computer. True when the daemon held work for it. */
    stopSession: (sessionId: string): boolean => {
      const held = inSession(sessionId)
      endRuns(sessions.stop(sessionId))
      for (const entry of held) end(entry, { ...EXECUTOR_SESSION_STOPPED_RESULT })
      changed()
      return held.length > 0
    },
    closeSessions: (closes: readonly ExecutorSessionClose[]): void => {
      for (const { sessionId } of closes) {
        const held = inSession(sessionId)
        endRuns(sessions.close(sessionId))
        for (const entry of held) end(entry, undefined)
        options.onSessionClosed?.(sessionId)
      }
      if (closes.length) changed()
    },
    // Only Nessie's own session ids, and stop files' ids that were checked as UUIDs, are named.
    stoppedSessions: (): ExecutorSessionId[] => sessions.stopped() as ExecutorSessionId[],
    isStopped: (sessionId: string): boolean => sessions.isStopped(sessionId),
    setMode: (next: CommandDispatcherMode): void => {
      if (mode === next) return
      mode = next
      queue.pump()
    },
    mode: (): CommandDispatcherMode => mode,
    held: (): number => entries.size,
    idle: (): boolean => entries.size === 0,
    activeCommands: (): ExecutorCommandCancellationTarget[] => [...entries.values()]
      .slice(0, EXECUTOR_ACTIVE_COMMANDS_MAXIMUM).map((entry) => cancellationTargetOf(entry.record.command)),
    waiting: (): ExecutorCommandWait[] => [...entries.values()].flatMap((entry): ExecutorCommandWait[] => {
      const status = statusOf(entry)
      return status === 'running' ? [] : [{ commandId: entry.record.command.commandId, for: status === 'queued' ? 'start' : 'owner' }]
    }).slice(0, EXECUTOR_ACTIVE_COMMANDS_MAXIMUM),
    /** Free slots per kind; none while paused, so Nessie sends nothing but stops. */
    capacity: (): ExecutorCommandCapacity => {
      if (options.paused()) return NO_CAPACITY
      const used: Partial<Record<ExecutorCommandCapacityKind, number>> = {}
      for (const entry of entries.values()) {
        const kind = commandKind(entry.record.command)
        if (kind && occupies(entry)) used[kind] = (used[kind] ?? 0) + 1
      }
      return freeCapacity(COMPUTER_COMMAND_LIMITS, used)
    },
    /** One row per session with held work, for `sessions.json`. */
    sessions: (): SessionView[] => {
      const views = new Map<string, SessionView>()
      for (const entry of entries.values()) {
        const { command } = entry.record
        const view = sessionCommandView(command, statusOf(entry), {
          bridge: options.bridge(),
          site: sites.get(String(command.payload.runId)),
          ...(entry.ownerRequest ? { requestId: entry.ownerRequest } : {}),
        })
        if (!view) continue
        const key = sessionKeyOf(command)
        const agentName = sessions.agentName(key)
        const session = views.get(key) ?? {
          sessionId: key, ...(agentName ? { agentName } : {}),
          startedAt: sessions.startedAt(key) ?? entry.record.receivedAt, commands: [],
        }
        session.commands.push(view)
        views.set(key, session)
      }
      return [...views.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    },
    /**
     * Starts no new `kind` command, waits for running ones to finish, runs
     * `work`, and lets them start again: how local apps are replaced while
     * other work goes on.
     */
    between: async (kind: ExecutorCommandCapacityKind, work: () => Promise<void>): Promise<void> => {
      const release = queue.holdKind(kind)
      try {
        while (queue.running(kind) > 0) await new Promise((resolve) => { setTimeout(resolve, 50).unref() })
        await work()
      } finally {
        release()
      }
    },
    /** Starts nothing more and waits for running commands; waiting ones resume after a restart. */
    shutdown: async (): Promise<void> => {
      // A program request dies with the daemon that holds it (`program-requests.ts`), so its command ends now.
      for (const entry of entries.values()) if (entry.ownerRequest) end(entry, { ...OWNER_GONE_RESULT })
      const running = [...entries.values()].filter((entry) => entry.release || entry.ownerRequest
        || entry.record.phase === 'result_pending' || (entry.record.phase === 'executing' && !entry.queued))
      closing = true
      for (const entry of entries.values()) if (entry.retry) clearTimeout(entry.retry)
      for (const kind of EXECUTOR_COMMAND_CAPACITY_KINDS) queue.holdKind(kind)
      await Promise.allSettled(running.map((entry) => entry.task))
    },
  }
}

export type CommandDispatcher = ReturnType<typeof createCommandDispatcher>
