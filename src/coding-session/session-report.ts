import { EXECUTOR_CODING_SESSION_OPEN_STATUSES, EXECUTOR_CODING_SESSION_REPORT_MAXIMUM } from '@nessie/executor-protocol'

import type { PathRewriter } from './path-rewrite.js'
import { codingSessionPaths, readJsonPatiently } from './session-files.js'
import { pendingOf, readSessionRequests } from './session-request-file.js'
import { listSessionMetas } from './session-requests.js'
import { deriveCodingStatus } from './status.js'
import type { CodingSessionState } from './types.js'

/**
 * A session report as the API reads it: open sessions before any other, then
 * cut to the cap. The cap then only ever drops ended or saved sessions, so the
 * API may read an open session missing from the report as ended. Order is
 * otherwise kept, newest first as each list already is.
 */
export const openFirst = <T extends { status?: unknown }>(
  sessions: readonly T[], maximum = EXECUTOR_CODING_SESSION_REPORT_MAXIMUM,
): T[] => {
  const open = (session: T) => EXECUTOR_CODING_SESSION_OPEN_STATUSES.has(String(session.status))
  return [...sessions.filter(open), ...sessions.filter((session) => !open(session))]
    .slice(0, maximum)
}

/** The report's own limit; a title a rewrite lengthened is clipped rather than dropped from the report. */
const TITLE_MAX = 120

const clipTitle = (title: string): string => (title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title)

/**
 * What the session has cost across its turns, once a turn has reported a cost — the figure
 * `session_status` answers, which a ticket's work and the heartbeat intake add to its spend.
 */
export const costOf = (state: CodingSessionState | undefined): { totalCostUsd?: number } => (
  state?.totalCostUsd === undefined ? {} : { totalCostUsd: state.totalCostUsd }
)

/**
 * What the daemon reports on its heartbeat (open sessions only) and in its
 * inventory (closed ones too): newest first, by title, status, agent, root,
 * owner, its turn count, when its last turn ended, what it has cost so far
 * and what kind of answer it waits on — nothing any of them said or did.
 */
export const reportCodingSessions = async (
  stateDir: string, rewriter: PathRewriter, includeClosed: boolean,
): Promise<Record<string, unknown>[]> => {
  const sessions = []
  for (const session of await listSessionMetas(stateDir)) {
    const paths = codingSessionPaths(stateDir, session.sessionId)
    const state = await readJsonPatiently<CodingSessionState>(paths.state)
    const derived = await deriveCodingStatus(paths, state)
    if (!includeClosed && derived.status === 'closed') continue
    sessions.push({
      sessionId: session.sessionId, ownerKey: session.ownerKey,
      title: clipTitle(rewriter.rewrite(session.title)), status: derived.status,
      ...(derived.reason ? { reason: derived.reason } : {}),
      agent: session.agent, root: session.rootName, updatedAt: state?.updatedAt ?? session.createdAt,
      turn: state?.turn ?? 0, lastTurnEndedAt: state?.lastTurnEndedAt ?? null, ...costOf(state),
      ...pendingOf(await readSessionRequests(paths, derived.hostLive)),
    })
  }
  sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return openFirst(sessions, includeClosed ? 5000 : undefined)
}
