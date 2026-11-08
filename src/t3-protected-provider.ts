import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import { type ProtectedT3Process, protectedDeliveryUnknown } from './t3-protected-stream.js'

/** Original adapters retain their SDK lifecycle. Ordinary Writable input is
 * deliberately absent: only explicitly admitted serializer frames may be sent. */
export class ProtectedT3Provider extends EventEmitter {
  readonly stdout: Readable
  readonly stderr: Readable
  readonly closed: Promise<void>
  readonly #child: ProtectedT3Process
  constructor(child: ProtectedT3Process) {
    super()
    this.#child = child
    this.stdout = child.stdout
    this.stderr = child.stderr
    this.closed = child.closed
    child.on('exit', (code: number | null, signal: null) => this.emit('exit', code, signal))
    child.on('close', (code: number | null, signal: null) => this.emit('close', code, signal))
    child.on('error', (error: Error) => { if (this.listenerCount('error')) this.emit('error', error) })
  }
  get pid(): number { return this.#child.pid }
  get exitCode(): number | null { return this.#child.exitCode }
  /** Available only after independently observed child/Job clearance. */
  async completion(): Promise<unknown> {
    await this.closed
    return structuredClone(this.#child.completion)
  }
  async endInput(): Promise<void> {
    if (this.#child.stdin.destroyed) throw protectedDeliveryUnknown()
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { this.#child.stdin.off('error', fail); reject(error) }
      this.#child.stdin.once('error', fail)
      this.#child.stdin.end(() => { this.#child.stdin.off('error', fail); resolve() })
    })
  }
  terminate(): Promise<void> { return this.#child.terminate() }
}
