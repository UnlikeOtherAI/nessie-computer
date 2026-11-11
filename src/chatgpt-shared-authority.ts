import type { ExecutorChatgptContext } from '@nessie/executor-protocol'

/**
 * The oldest answer a credential lease may reuse. The plan's host already asks
 * Nessie every five seconds and stops the moment the answer changes or fails,
 * so a lease that reuses that answer is no weaker than the request it starts:
 * both lose their authority at the next check.
 */
export const CHATGPT_AUTHORITY_MAX_AGE_MS = 10_000

export type SharedChatgptAuthority = {
  /** Asks Nessie now. Callers that arrive while one question is open share its answer. */
  fresh: () => Promise<ExecutorChatgptContext>
  /** The last answer while it is recent and unexpired; otherwise asks. */
  recent: () => Promise<ExecutorChatgptContext>
}

/**
 * One owner/team check for a plan's host, shared by its five-second check and
 * every credential lease. Each lease used to ask Nessie again, and a turn takes
 * three leases: six round trips before, during and after every model request.
 * A failed check forgets the last answer, so nothing is leased on stale words.
 */
export const shareChatgptAuthority = (
  renew: () => Promise<ExecutorChatgptContext>,
  options: { maxAgeMs?: number; now?: () => number } = {},
): SharedChatgptAuthority => {
  const now = options.now ?? Date.now
  const maxAge = options.maxAgeMs ?? CHATGPT_AUTHORITY_MAX_AGE_MS
  let asking: Promise<ExecutorChatgptContext> | undefined
  let last: { answeredAt: number; context: ExecutorChatgptContext } | undefined
  const fresh = (): Promise<ExecutorChatgptContext> => {
    asking ??= renew().then((context) => {
      last = { answeredAt: now(), context }
      return context
    }, (error: unknown) => {
      last = undefined
      throw error
    }).finally(() => { asking = undefined })
    return asking
  }
  return {
    fresh,
    recent: () => {
      if (last && now() - last.answeredAt < maxAge && Date.parse(last.context.expiresAt) > now()) {
        return Promise.resolve(last.context)
      }
      return fresh()
    },
  }
}
