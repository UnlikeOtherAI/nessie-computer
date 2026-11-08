import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

export const protectedDeliveryUnknown = () => new Error('T3_NATIVE_DELIVERY_UNKNOWN')
type Frame = Record<string, unknown>
export type ProtectedWire = { input: Writable; output: Readable; dispose(): void }
export function encodeProtectedFrame(value: Frame): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  if (payload.length === 0 || payload.length > 65_536) throw protectedDeliveryUnknown()
  const frame = Buffer.allocUnsafe(payload.length + 4)
  frame.writeUInt32LE(payload.length)
  payload.copy(frame, 4)
  return frame
}

/** Only fixed native companions use this transport. This class grants no
 * provider input authority. Do not attach an SDK stdin to it. */
export class ProtectedT3Process extends EventEmitter {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly closed: Promise<void>
  readonly ready: Promise<void>
  pid = 0
  exitCode: number | null = null
  completion: unknown
  #wire: ProtectedWire
  #buffer = Buffer.alloc(0)
  #blocked = new Set<Readable>()
  #sequence = 0
  #settled = false
  #admitted = false
  #stopping = false
  #stopTimer?: ReturnType<typeof setTimeout>
  #pending?: { sequence: number | 'end'; resolve(): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout> }
  #resolve!: () => void
  #reject!: (error: Error) => void
  #readyResolve!: () => void
  #readyReject!: (error: Error) => void
  #verifyReady: (frame: Frame) => number
  #control?: { sequence: number; resolve(value: unknown): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout> }

  constructor(wire: ProtectedWire, verifyReady: (frame: Frame) => number,
    inputMode: 'companion' | 'finite' = 'companion') {
    super()
    this.#wire = wire
    this.#verifyReady = verifyReady
    this.closed = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject })
    this.ready = new Promise((resolve, reject) => { this.#readyResolve = resolve; this.#readyReject = reject })
    // Rejections remain observable on the original promises, including before
    // a caller has attached its close handler.
    void this.closed.catch(() => undefined)
    void this.ready.catch(() => undefined)
    const output = () => {
      const stream: Readable = new Readable({ highWaterMark: 16_384, read: () => {
        this.#blocked.delete(stream)
        if (this.#blocked.size === 0) { this.#drain(); wire.output.resume() }
      } })
      return stream
    }
    this.stdout = output()
    this.stderr = output()
    this.stdin = new Writable({ highWaterMark: 16_384,
      write: (chunk: Buffer, _encoding, callback) => {
        if (inputMode === 'finite') { callback(protectedDeliveryUnknown()); return }
        void this.#writeBytes(chunk).then(() => callback(), error => callback(error as Error))
      },
      final: callback => {
        void this.#ack('end', { kind: 'stdinEnd' }).then(() => callback(), error => callback(error as Error))
      },
    })
    this.stdin.on('error', () => { void this.terminate().catch(() => undefined) })
    wire.input.on('error', () => this.#fail())
    wire.output.on('error', () => this.#fail())
    wire.output.on('end', () => { if (!this.#settled) this.#fail() })
    wire.output.on('close', () => { if (!this.#settled) this.#fail() })
    wire.output.on('data', (bytes: Buffer) => {
      if (this.#settled) return
      if (this.#buffer.length + bytes.length > 196_608) { this.#fail(); return }
      this.#buffer = Buffer.concat([this.#buffer, bytes])
      this.#drain()
    })
  }

  async sendInitial(frame: Frame): Promise<void> {
    await this.#send(frame)
    const timer = setTimeout(() => this.#fail(), 10_000)
    try { await this.ready } finally { clearTimeout(timer) }
  }

  /** Service validates each typed finite operation; this method carries no grant. */
  requestFrame(request: Frame): Promise<unknown> {
    if (this.#control || this.#pending || !this.#admitted || this.#stopping || this.#settled) {
      return Promise.reject(protectedDeliveryUnknown())
    }
    const sequence = ++this.#sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(), 6000)
      this.#control = { sequence, resolve, reject, timer }
      void this.#send({ kind: 'frame', sequence, request }).catch(() => this.#fail())
    })
  }

  #send(frame: Frame): Promise<void> {
    if (this.#settled) return Promise.reject(protectedDeliveryUnknown())
    return new Promise((resolve, reject) => {
      this.#wire.input.write(encodeProtectedFrame(frame), error => error ? reject(error) : resolve())
    })
  }
  async #writeBytes(bytes: Buffer): Promise<void> {
    if (!this.#admitted || this.#stopping) throw protectedDeliveryUnknown()
    for (let offset = 0; offset < bytes.length; offset += 16_384) {
      const sequence = ++this.#sequence
      await this.#ack(sequence, { kind: 'stdin', sequence,
        data: bytes.subarray(offset, offset + 16_384).toString('base64') })
    }
  }
  #ack(sequence: number | 'end', frame: Frame): Promise<void> {
    if (this.#pending || this.#control || !this.#admitted || this.#stopping || this.#settled) {
      return Promise.reject(protectedDeliveryUnknown())
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(), 6000)
      this.#pending = { sequence, resolve, reject, timer }
      void this.#send(frame).catch(() => this.#fail())
    })
  }
  #drain(): void {
    try {
      while (!this.#settled && this.#blocked.size === 0 && this.#buffer.length >= 4) {
        const size = this.#buffer.readUInt32LE(0)
        if (size === 0 || size > 65_536) throw protectedDeliveryUnknown()
        if (this.#buffer.length < size + 4) break
        const frame: unknown = JSON.parse(this.#buffer.subarray(4, size + 4).toString('utf8'))
        this.#buffer = this.#buffer.subarray(size + 4)
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw protectedDeliveryUnknown()
        this.#frame(frame as Frame)
      }
      if (this.#blocked.size) this.#wire.output.pause()
    } catch { this.#fail() }
  }
  #frame(frame: Frame): void {
    if (!this.#admitted) {
      this.pid = this.#verifyReady(frame)
      if (!Number.isSafeInteger(this.pid) || this.pid <= 0) throw protectedDeliveryUnknown()
      this.#admitted = true
      this.#readyResolve()
      return
    }
    switch (frame.kind) {
      case 'frameResult': {
        const pending = this.#control
        if (!pending || pending.sequence !== frame.sequence) throw protectedDeliveryUnknown()
        clearTimeout(pending.timer)
        this.#control = undefined
        pending.resolve(frame.result)
        return
      }
      case 'stdout': case 'stderr': {
        if (typeof frame.data !== 'string' || frame.data.length > 24_000) throw protectedDeliveryUnknown()
        const bytes = Buffer.from(frame.data, 'base64')
        if (bytes.toString('base64') !== frame.data) throw protectedDeliveryUnknown()
        const stream = frame.kind === 'stdout' ? this.stdout : this.stderr
        if (!stream.push(bytes)) this.#blocked.add(stream)
        return
      }
      case 'written': case 'inputEnded': {
        const sequence = frame.kind === 'written' ? frame.sequence : 'end'
        const pending = this.#pending
        if (!pending || pending.sequence !== sequence) throw protectedDeliveryUnknown()
        clearTimeout(pending.timer)
        this.#pending = undefined
        pending.resolve()
        return
      }
      case 'exit':
        if (!Number.isSafeInteger(frame.code) || (frame.code as number) < 0 || this.exitCode !== null) {
          throw protectedDeliveryUnknown()
        }
        this.exitCode = frame.code as number
        this.emit('exit', this.exitCode, null)
        return
      case 'closed':
        if (frame.cleared !== true || this.#control || (this.#pending && this.#pending.sequence !== 'end')) {
          throw protectedDeliveryUnknown()
        }
        // Positive stop may race EOF after every byte was acknowledged. EOF
        // has no payload; it cannot turn an unacknowledged byte write into success.
        if (this.#pending) {
          clearTimeout(this.#pending.timer)
          this.#pending.resolve()
          this.#pending = undefined
        }
        this.#settled = true
        this.completion = structuredClone(frame.completion)
        clearTimeout(this.#stopTimer)
        this.stdout.push(null)
        this.stderr.push(null)
        this.#resolve()
        this.emit('close', this.exitCode, null)
        this.#wire.dispose()
        return
      case 'error': {
        if (frame.code !== 'T3_NATIVE_DELIVERY_UNKNOWN') throw protectedDeliveryUnknown()
        const error = protectedDeliveryUnknown()
        if (this.#control) { clearTimeout(this.#control.timer); this.#control.reject(error); this.#control = undefined }
        if (this.#pending) { clearTimeout(this.#pending.timer); this.#pending.reject(error); this.#pending = undefined }
        this.stdin.destroy(error)
        if (this.listenerCount('error')) this.emit('error', error)
        return
      }
      default: throw protectedDeliveryUnknown()
    }
  }
  #fail(): void {
    if (this.#settled) return
    this.#settled = true
    const error = protectedDeliveryUnknown()
    if (this.#control) { clearTimeout(this.#control.timer); this.#control.reject(error); this.#control = undefined }
    clearTimeout(this.#stopTimer)
    if (this.#pending) { clearTimeout(this.#pending.timer); this.#pending.reject(error); this.#pending = undefined }
    this.#readyReject(error)
    this.#reject(error)
    this.stdin.destroy(error)
    this.stdout.destroy()
    this.stderr.destroy()
    this.#wire.dispose()
    if (this.listenerCount('error')) this.emit('error', error)
  }
  async terminate(): Promise<void> {
    if (!this.#settled && !this.#stopping) {
      this.#stopping = true
      // Drain already accepted output so stop acknowledgement cannot be hidden
      // behind caller backpressure. No further input is accepted.
      this.stdout.resume()
      this.stderr.resume()
      this.#stopTimer = setTimeout(() => this.#fail(), 10_000)
      await this.#send({ kind: 'stop' }).catch(() => this.#fail())
    }
    await this.closed
  }
}
