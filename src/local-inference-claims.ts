import type { LocalInferenceHostLoop } from './local-inference-host.js'

/** A free local slot is waited for on the machine, never asked of the server. */
const SLOT_WAIT_MS = 500
/** Work announced this long ago without a free slot has met its attempt deadline. */
const WANT_TTL_MS = 5 * 60_000

/**
 * Claims only when told there may be work: the socket's `attempt_available`,
 * its (re)connection, or a generation of this host ending. It claims until
 * the server answers idle, so a started generation runs on beside the next
 * claim and one host fills every slot it has. When its own generations hold
 * every slot it stops, because each one's end announces again; when another
 * process on the machine holds the slot it waits on the shared coordinator
 * (a file read, not a request) and claims the moment the slot frees.
 */
export class LocalInferenceClaimScheduler {
  #wanted = 0
  #served = 0
  #wantedAt = 0
  #driving: Promise<void> | null = null
  #wait: { timer: NodeJS.Timeout; resolve: () => void } | null = null
  #running = new Set<Promise<unknown>>()
  #stopped = false

  constructor(
    private readonly loop: Pick<LocalInferenceHostLoop, 'claimOnce' | 'stop'>,
    private readonly options: { onError?: (error: unknown) => void; now?: () => number; slotWaitMs?: number } = {},
  ) {}

  /** There may be work: claim until the server says there is none. */
  available(): void {
    if (this.#stopped) return
    this.#wanted += 1
    this.#wantedAt = this.now()
    this.wake()
    this.#driving ??= this.drive().finally(() => { this.#driving = null })
  }

  async stop(): Promise<void> {
    if (!this.#stopped) { this.#stopped = true; this.loop.stop() }
    this.wake()
    await Promise.allSettled([...(this.#driving ? [this.#driving] : []), ...this.#running])
  }

  /** Settles when the current claim chain and every generation it started have ended. */
  async idle(): Promise<void> {
    while (this.#driving || this.#running.size > 0) {
      await Promise.allSettled([...(this.#driving ? [this.#driving] : []), ...this.#running])
    }
  }

  private async drive(): Promise<void> {
    while (!this.#stopped && this.#served < this.#wanted) {
      if (this.now() - this.#wantedAt > WANT_TTL_MS) { this.#served = this.#wanted; return }
      const serial = this.#wanted
      try {
        const outcome = await this.loop.claimOnce()
        if (outcome.kind === 'busy') {
          if (this.#running.size > 0) this.#served = Math.max(this.#served, serial)
          else await this.sleep()
          continue
        }
        if (outcome.kind === 'started') {
          const running: Promise<unknown> = outcome.completion
            .catch((error: unknown) => this.options.onError?.(error))
            .finally(() => { this.#running.delete(running); this.available() })
          this.#running.add(running)
          continue
        }
        // A replayed receipt or a fenced lease used the claim; ask again.
        if (outcome.kind === 'completed' || outcome.kind === 'fenced') continue
        this.#served = Math.max(this.#served, serial)
      } catch (error) {
        // The socket's reconnection announces again; nothing here retries a request.
        this.options.onError?.(error)
        this.#served = Math.max(this.#served, serial)
      }
    }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.#wait = null; resolve() }, this.options.slotWaitMs ?? SLOT_WAIT_MS)
      this.#wait = { resolve: () => { clearTimeout(timer); this.#wait = null; resolve() }, timer }
    })
  }

  private wake(): void { this.#wait?.resolve() }

  private now(): number { return this.options.now?.() ?? Date.now() }
}
