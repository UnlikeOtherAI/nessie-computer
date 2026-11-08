/** A local replay refusal, never a secret-read permit. The native service and
 * backend independently consume the accepted graph/full-array slot identity.
 * Keep this owner on the graph lease, not on a plan, read or open callback. */
export class SessionSecretReadAttempts {
  readonly #attempted = new Set<number>()
  readonly #parent: AbortSignal
  readonly #expiresAt: number
  constructor(parent: AbortSignal, expiresAt: number) {
    if (!Number.isSafeInteger(expiresAt)) throw new Error('T3_SESSION_SECRET_READ_ATTEMPT_REFUSED')
    this.#parent = parent
    this.#expiresAt = expiresAt
  }

  scope(signal: AbortSignal): ScopedSessionSecretReadAttempts {
    let live = true
    return Object.freeze({
      claim: (originalEnvironmentIndex: number): void => {
        if (!live || signal.aborted || this.#parent.aborted || Date.now() >= this.#expiresAt
          || !Number.isSafeInteger(originalEnvironmentIndex)
          || originalEnvironmentIndex < 0 || originalEnvironmentIndex > 255
          || this.#attempted.has(originalEnvironmentIndex)) {
          throw new Error('T3_SESSION_SECRET_READ_ATTEMPT_REFUSED')
        }
        // Before native preparation or any await. Failure, timeout and unknown
        // delivery leave this entry terminal; there is deliberately no reset.
        this.#attempted.add(originalEnvironmentIndex)
      },
      close: (): void => { live = false },
    })
  }
}

export interface ScopedSessionSecretReadAttempts {
  claim(originalEnvironmentIndex: number): void
  close(): void
}
