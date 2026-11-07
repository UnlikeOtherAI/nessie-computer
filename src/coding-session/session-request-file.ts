import {
  ExecutorSessionRequestSchema, summarizePendingRequests,
  type ExecutorSessionPendingSummary, type ExecutorSessionRequest,
} from '@nessie/executor-protocol'

import { readJsonPatiently, writeJsonAtomic, type CodingSessionPaths } from './session-files.js'

/**
 * `requests.json`, which only the session's host writes. A reader takes it as
 * the host last wrote it, except that a request still pending when no host is
 * alive to answer it reads as expired (`executor_restarted`): its provider
 * went with that host, and the next host settles it the same way on disk.
 */
export const readSessionRequests = async (
  paths: CodingSessionPaths, hostLive: boolean,
): Promise<ExecutorSessionRequest[]> => {
  const file = await readJsonPatiently<{ requests?: unknown }>(paths.requests)
  const entries = Array.isArray(file?.requests) ? file.requests : []
  return entries.flatMap((entry) => {
    const parsed = ExecutorSessionRequestSchema.safeParse(entry)
    if (!parsed.success) return []
    return [parsed.data.status === 'pending' && !hostLive
      ? { ...parsed.data, status: 'expired' as const, reason: 'executor_restarted' } : parsed.data]
  })
}

export const writeSessionRequests = (
  paths: CodingSessionPaths, requests: readonly ExecutorSessionRequest[],
): Promise<void> => (
  writeJsonAtomic(paths.requests, { version: 1, requests })
)

/** A list row's `pending`, or nothing to spread when nothing waits. */
export const pendingOf = (requests: readonly ExecutorSessionRequest[]): { pending?: ExecutorSessionPendingSummary } => {
  const pending = summarizePendingRequests(requests)
  return pending ? { pending } : {}
}
