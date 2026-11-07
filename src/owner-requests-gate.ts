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
  /**
   * Hold session rows back for a moment rather than send them stripped. After
   * a new connection epoch, a Nessie that read requests on the previous epoch
   * almost certainly still does and says `ready` within a second; a stripped
   * row would tell it every wait had ended, clearing the row and ringing the
   * owner again when the wait reappears. Never held at daemon start (nothing
   * is known of the server yet, and an older one must still get its rows),
   * and never longer than `REPORT_HOLD_MS` per epoch.
   */
  holdReports: () => boolean
}

export const REPORT_HOLD_MS = 10_000

export const createOwnerRequestsGate = (
  currentEpoch: () => string | undefined, now: () => number = Date.now,
): OwnerRequestsGate => {
  let readyEpoch: string | undefined
  let everReady = false
  let heldEpoch: string | undefined
  let heldSince = 0
  const understood = (): boolean => readyEpoch !== undefined && readyEpoch === currentEpoch()
  return {
    ready: (connectionEpoch) => { readyEpoch = connectionEpoch; everReady = true },
    understood,
    holdReports: () => {
      if (!everReady || understood()) return false
      const epoch = currentEpoch()
      if (epoch !== heldEpoch) { heldEpoch = epoch; heldSince = now() }
      return now() - heldSince < REPORT_HOLD_MS
    },
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
