import type { ExecutorMcpUnavailableReason } from '@nessie/executor-protocol'

/**
 * How long a local app that keeps failing to start waits before it is tried
 * again. The first failures in a row are retried at once — a slow first start,
 * a device that has just come back. After that it waits a minute, then twice as
 * long after every further failure, up to half an hour. A start that works
 * forgets them all. Without this a local app whose device was away (Kelpie for
 * a phone that is off) was started again at every two-minute report, for as
 * long as the daemon ran.
 */
export const MCP_START_IMMEDIATE_RETRIES = 2
export const MCP_START_BACKOFF_MS = 60_000
export const MCP_START_BACKOFF_MAX_MS = 30 * 60_000

/** A local app that failed to start, as `describe` reports it (`local-app-start-status.ts`). */
export type LocalAppStartFailure = {
  name: string
  /** Failed starts in a row. */
  failures: number
  reason: ExecutorMcpUnavailableReason
  /** When it is tried again; absent while a failure is still retried at once. */
  retryAt?: string
}

export type StartBackoff = {
  /** The last failure's reason while a start must wait; `undefined` when one may be tried now. */
  waiting: (server: string) => ExecutorMcpUnavailableReason | undefined
  failed: (server: string, reason: ExecutorMcpUnavailableReason) => void
  started: (server: string) => void
  snapshot: () => LocalAppStartFailure[]
}

export const createStartBackoff = (options: {
  baseMs?: number
  maxMs?: number
  now?: () => number
  /** Hears every change, with the whole list. */
  onChange?: (failures: LocalAppStartFailure[]) => void
} = {}): StartBackoff => {
  const baseMs = options.baseMs ?? MCP_START_BACKOFF_MS
  const maxMs = options.maxMs ?? MCP_START_BACKOFF_MAX_MS
  const now = options.now ?? Date.now
  const failures = new Map<string, { consecutive: number; notBefore: number; reason: ExecutorMcpUnavailableReason }>()
  const snapshot = (): LocalAppStartFailure[] => [...failures].map(([name, entry]) => ({
    name, failures: entry.consecutive, reason: entry.reason,
    ...(entry.notBefore > 0 ? { retryAt: new Date(entry.notBefore).toISOString() } : {}),
  }))
  return {
    waiting: (server) => {
      const entry = failures.get(server)
      return entry && entry.notBefore > now() ? entry.reason : undefined
    },
    failed: (server, reason) => {
      const consecutive = (failures.get(server)?.consecutive ?? 0) + 1
      const waits = consecutive - MCP_START_IMMEDIATE_RETRIES
      const delay = waits > 0 ? Math.min(baseMs * 2 ** (waits - 1), maxMs) : 0
      failures.set(server, { consecutive, notBefore: delay > 0 ? now() + delay : 0, reason })
      options.onChange?.(snapshot())
    },
    started: (server) => {
      if (failures.delete(server)) options.onChange?.(snapshot())
    },
    snapshot,
  }
}
