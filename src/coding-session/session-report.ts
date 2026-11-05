import { EXECUTOR_CODING_SESSION_OPEN_STATUSES, EXECUTOR_CODING_SESSION_REPORT_MAXIMUM } from '@nessie/executor-protocol'

/**
 * A session report as the API reads it: open sessions before any other, then
 * cut to the cap. The cap then only ever drops ended or saved sessions, so the
 * API may read an open session missing from the report as ended. Order is
 * otherwise kept, newest first as each list already is.
 */
export const openFirst = <T extends { status?: unknown }>(sessions: readonly T[]): T[] => {
  const open = (session: T) => EXECUTOR_CODING_SESSION_OPEN_STATUSES.has(String(session.status))
  return [...sessions.filter(open), ...sessions.filter((session) => !open(session))]
    .slice(0, EXECUTOR_CODING_SESSION_REPORT_MAXIMUM)
}
