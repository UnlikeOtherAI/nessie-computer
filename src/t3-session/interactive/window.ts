import { InteractiveFailure, requireInteractive, type InteractiveFailureCode } from './operations.js'

export const INTERACTIVE_STREAM_LIMITS = Object.freeze({
  chunks: 8, windowBytes: 64 * 1024, frameBytes: 1024 * 1024, queuedBytes: 8 * 1024 * 1024,
  queuedChunks: 1024, leaseMilliseconds: 60_000,
})

export interface InteractiveFrame {
  readonly ordinal: number
  readonly bytes: Uint8Array
}

/** Executor-local relay window, not a history buffer or command receipt store.
 * Original source snapshots/sequences remain in the encoded frame unchanged.
 * A transport disconnect discards this window; reconnect uses the source's resume API.
 */
export class InteractiveStreamWindow {
  readonly #queued: InteractiveFrame[] = []
  readonly #sent: InteractiveFrame[] = []
  readonly #signal: AbortSignal
  readonly #deadline: number
  readonly #expiry: ReturnType<typeof setTimeout>
  #bytes = 0
  #sentBytes = 0
  #nextOrdinal = 0
  #lastAcknowledged = -1
  #closed: InteractiveFailureCode | undefined
  readonly #abort = () => { this.close('resource_expired') }

  constructor(signal: AbortSignal, authorizationDeadline: number) {
    const remaining = authorizationDeadline - Date.now()
    requireInteractive(Number.isFinite(remaining) && remaining > 0
      && remaining <= INTERACTIVE_STREAM_LIMITS.leaseMilliseconds, 'resource_expired')
    this.#signal = signal
    this.#deadline = authorizationDeadline
    this.#expiry = setTimeout(this.#abort, remaining)
    this.#expiry.unref()
    signal.addEventListener('abort', this.#abort, { once: true })
    if (signal.aborted) this.close('resource_expired')
  }

  #check(): void {
    if (this.#signal.aborted || Date.now() >= this.#deadline) this.close('resource_expired')
    if (this.#closed) throw new InteractiveFailure(this.#closed)
  }

  enqueue(bytes: Uint8Array): void {
    this.#check()
    const limits = INTERACTIVE_STREAM_LIMITS
    // Charge count as well as bytes so zero-length events cannot grow an unbounded queue.
    if (bytes.byteLength > limits.frameBytes || this.#bytes + bytes.byteLength > limits.queuedBytes
      || this.#queued.length + this.#sent.length >= limits.queuedChunks
      || !Number.isSafeInteger(this.#nextOrdinal + 1)) {
      this.close('stream_capacity')
      throw new InteractiveFailure('stream_capacity')
    }
    this.#queued.push({ ordinal: this.#nextOrdinal++, bytes: Uint8Array.from(bytes) })
    this.#bytes += bytes.byteLength
  }

  /** Empty means temporarily no demand/data. Closed/expired/overflow is always an error. */
  take(): InteractiveFrame | undefined {
    this.#check()
    const frame = this.#queued[0]
    if (!frame || this.#sent.length >= INTERACTIVE_STREAM_LIMITS.chunks) return undefined
    // One bounded snapshot/frame may exceed the byte window, but never the frame limit.
    if (this.#sent.length > 0 && this.#sentBytes + frame.bytes.byteLength > INTERACTIVE_STREAM_LIMITS.windowBytes) {
      return undefined
    }
    this.#queued.shift()
    this.#sent.push(frame)
    this.#sentBytes += frame.bytes.byteLength
    // A caller cannot mutate retained bytes or change their charged length.
    return { ordinal: frame.ordinal, bytes: Uint8Array.from(frame.bytes) }
  }

  /** Exact ordered ACKs. Duplicate ACKs are harmless; future/skipped ACKs grant no credit. */
  acknowledge(ordinal: number): void {
    this.#check()
    requireInteractive(Number.isSafeInteger(ordinal) && ordinal >= 0, 'invalid_ack')
    if (ordinal <= this.#lastAcknowledged) return
    const frame = this.#sent[0]
    requireInteractive(frame?.ordinal === ordinal, 'invalid_ack')
    this.#sent.shift()
    this.#sentBytes -= frame.bytes.byteLength
    this.#bytes -= frame.bytes.byteLength
    this.#lastAcknowledged = ordinal
  }

  close(reason: InteractiveFailureCode = 'stream_closed'): void {
    if (this.#closed) return
    this.#closed = reason
    clearTimeout(this.#expiry)
    this.#signal.removeEventListener('abort', this.#abort)
    this.#queued.length = 0
    this.#sent.length = 0
    this.#bytes = 0
    this.#sentBytes = 0
  }
}
