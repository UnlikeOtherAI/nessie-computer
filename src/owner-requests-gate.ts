import type {
  ExecutorCodingSessionSummary, ExecutorLocalMcpReport, ExecutorSessionConversation,
} from '@nessie/executor-protocol'

/**
 * Whether the Nessie this daemon is connected to reads what a session waits on
 * its owner for: the `pending` summary on a session's row and a conversation's
 * `requests`.
 *
 * Both are new fields inside schemas an older Nessie parses strictly, so a
 * heartbeat or a session exchange carrying either is refused whole there, and
 * the computer goes offline while anything waits — a Codex thread waiting on
 * its own client included. An older Nessie also has no doorbell, so the
 * doorbell's `ready` is the proof: a Nessie that said `ready` to the connect
 * proof of the current connection epoch reads them. Until then the daemon
 * leaves both fields out, and its session hosts turn every provider prompt
 * down at once, as they did before a prompt could reach the owner
 * (`coding-session/owner-requests-lease.ts`). A new epoch (a reconnect, which
 * may meet a different Nessie) waits for its own `ready`.
 */
export type OwnerRequestsGate = {
  /** The doorbell said `ready` to a connect proof signed under this epoch. */
  ready: (connectionEpoch: string) => void
  /** The current connection's Nessie has shown it reads `pending` and `requests`. */
  understood: () => boolean
}

export const createOwnerRequestsGate = (currentEpoch: () => string | undefined): OwnerRequestsGate => {
  let readyEpoch: string | undefined
  return {
    ready: (connectionEpoch) => { readyEpoch = connectionEpoch },
    understood: () => readyEpoch !== undefined && readyEpoch === currentEpoch(),
  }
}

/** A list row as a Nessie that has not shown it reads `pending` may receive it. */
export const summaryForServer = (
  summary: ExecutorCodingSessionSummary, understood: boolean,
): ExecutorCodingSessionSummary => {
  if (understood || summary.pending === undefined) return summary
  const { pending: _pending, ...rest } = summary
  return rest
}

/** The local-MCP report as the heartbeat may carry it. */
export const reportForServer = (
  report: ExecutorLocalMcpReport | undefined, understood: boolean,
): ExecutorLocalMcpReport | undefined => (understood || !report ? report : report.map((status) => (
  status.codingSessions
    ? { ...status, codingSessions: status.codingSessions.map((summary) => summaryForServer(summary, false)) }
    : status
)))

/** A conversation as the session exchange may carry it. */
export const conversationForServer = <T extends ExecutorSessionConversation | null | undefined>(
  conversation: T, understood: boolean,
): T => {
  if (understood || !conversation || conversation.requests === undefined) return conversation
  const { requests: _requests, ...rest } = conversation
  return rest as T
}
