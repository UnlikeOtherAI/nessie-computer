import type { ExecutorCommandEnvelope } from '@nessie/executor-protocol'

/**
 * The sessions the daemon has seen commands for (contract §11.1). Nessie
 * opens and closes sessions; the daemon only remembers what it needs to keep
 * its promises: which runs a session's commands used, so ending the session
 * ends their sandboxes and browsers; which sessions the owner stopped here and
 * Nessie has not closed yet; and which Nessie closed, so a late command for
 * one is refused rather than run.
 *
 * A command from a Nessie that sends no session counts its run as its
 * session (`sessionKeyOf`), so the owner can still see and stop that work;
 * only real sessions are named back to Nessie as stopped.
 */

export const EXECUTOR_SESSION_STOPPED_RESULT = Object.freeze({
  code: 'EXECUTOR_SESSION_STOPPED',
  message: 'The computer\'s owner stopped this session on the computer.',
  reason: 'owner_stopped',
  success: false,
})

export const EXECUTOR_SESSION_CLOSED_RESULT = Object.freeze({
  code: 'EXECUTOR_SESSION_CLOSED',
  message: 'This session already ended on the computer.',
  success: false,
})

/** How many closed session ids are remembered; an older one is a session Nessie will not send work for. */
const CLOSED_REMEMBERED = 1_024
/** How many open sessions are remembered; the oldest goes first, as a session no run uses any more. */
const SESSIONS_REMEMBERED = 4_096

type Session = { agentName?: string; firstSeen: string; fromNessie: boolean; runIds: Set<string> }

/** The session a command counts under: Nessie's, or its run's. */
export const sessionKeyOf = (command: ExecutorCommandEnvelope): string =>
  command.sessionId ?? String(command.payload.runId)

export type SessionTracker = {
  /** Remembers a command's session, agent and run. */
  note: (command: ExecutorCommandEnvelope, seenAt: string) => void
  /** When the daemon first saw work for the session. */
  startedAt: (sessionId: string) => string | undefined
  /** Why a command must not run because of its session, if it must not. */
  refusal: (command: ExecutorCommandEnvelope) => Record<string, unknown> | undefined
  agentName: (sessionId: string) => string | undefined
  /** The owner stopped a session here; answers the runs to end. */
  stop: (sessionId: string) => string[]
  /** Nessie closed a session; answers the runs to end. */
  close: (sessionId: string) => string[]
  isStopped: (sessionId: string) => boolean
  /** Stopped here and not yet closed by Nessie, for the poll's `stoppedSessions`. */
  stopped: () => string[]
  /** Forgets a closed session's details once none of its commands is held. */
  forget: (sessionId: string) => void
}

export const createSessionTracker = (): SessionTracker => {
  const sessions = new Map<string, Session>()
  const stopped = new Set<string>()
  const closed = new Set<string>()
  const runsOf = (sessionId: string): string[] => [...sessions.get(sessionId)?.runIds ?? []]
  return {
    note: (command, seenAt) => {
      const key = sessionKeyOf(command)
      const session = sessions.get(key)
        ?? { firstSeen: seenAt, fromNessie: command.sessionId !== undefined, runIds: new Set<string>() }
      if (seenAt < session.firstSeen) session.firstSeen = seenAt
      if (command.agentName) session.agentName = command.agentName
      if (typeof command.payload.runId === 'string') session.runIds.add(command.payload.runId)
      sessions.set(key, session)
      while (sessions.size > SESSIONS_REMEMBERED) sessions.delete(sessions.keys().next().value!)
    },
    startedAt: (sessionId) => sessions.get(sessionId)?.firstSeen,
    refusal: (command) => {
      const key = sessionKeyOf(command)
      if (closed.has(key)) return { ...EXECUTOR_SESSION_CLOSED_RESULT }
      if (stopped.has(key)) return { ...EXECUTOR_SESSION_STOPPED_RESULT }
      return undefined
    },
    agentName: (sessionId) => sessions.get(sessionId)?.agentName,
    stop: (sessionId) => {
      if (closed.has(sessionId)) return []
      stopped.add(sessionId)
      return runsOf(sessionId)
    },
    close: (sessionId) => {
      stopped.delete(sessionId)
      closed.delete(sessionId)
      closed.add(sessionId)
      while (closed.size > CLOSED_REMEMBERED) closed.delete(closed.values().next().value!)
      return runsOf(sessionId)
    },
    isStopped: (sessionId) => stopped.has(sessionId),
    // A stop file from before a restart names a session nothing has been seen for yet: it is named too.
    stopped: () => [...stopped].filter((id) => sessions.get(id)?.fromNessie !== false),
    forget: (sessionId) => {
      if (closed.has(sessionId)) sessions.delete(sessionId)
    },
  }
}
