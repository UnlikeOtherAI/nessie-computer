/** A plan host that ran this long before it failed starts its waits over. */
export const CHATGPT_HOST_SETTLED_MS = 60_000

/**
 * How long a plan's host waits before it connects again. Every connection
 * spends one of the host challenges Nessie allows a whole network in ten
 * minutes, shared by every computer behind it. A host that failed every three
 * seconds used them all, was refused, and kept every other computer's models
 * offline for as long as it went on trying.
 */
export const chatgptHostRetryDelayMs = (failures: number): number =>
  Math.min(60_000, 3000 * 2 ** Math.min(Math.max(failures, 1) - 1, 5))

/** Counts failures in a row; one after a settled run counts as the first. */
export const nextChatgptHostFailures = (failures: number, ranForMs: number): number =>
  ranForMs >= CHATGPT_HOST_SETTLED_MS ? 1 : failures + 1
