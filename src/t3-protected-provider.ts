import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { T3ExecutionFrameContextSchema, T3ExecutionSerializedFrameSchema, T3ExecutionReceiptSchema,
  T3ExecutionFrameAdmissionSchema, T3ExecutionSignedAdmissionSchema,
  T3EffectAuthorityCheckedSchema,
  type T3ExecutionFrameContext, type T3ExecutionSerializedFrame, type T3ExecutionReceipt,
  type T3ExecutionSignedAdmission, type T3EffectAuthorityChecked } from '@nessie/executor-protocol/t3-session'
import { z } from 'zod'
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
  /** Evidence only. The backend must admit the returned held-byte receipt. */
  async prepareFrame(bytes: Uint8Array, metadata: T3ExecutionSerializedFrame,
    captured: T3ExecutionFrameContext): Promise<T3ExecutionReceipt> {
    const frameId = await this.#uploadFrame(bytes, metadata, captured)
    return T3ExecutionReceiptSchema.parse(await this.#child.requestFrame({ operation: 'prepare', frameId }))
  }
  async #uploadFrame(bytes: Uint8Array, metadata: T3ExecutionSerializedFrame,
    captured: T3ExecutionFrameContext): Promise<string> {
    const payload = Buffer.from(bytes), frame = T3ExecutionSerializedFrameSchema.parse(metadata)
    const context = T3ExecutionFrameContextSchema.parse(captured)
    if (!payload.length || payload.length > 131_072
      || frame.frameSha256 !== 'sha256:' + createHash('sha256').update(payload).digest('hex')) {
      throw protectedDeliveryUnknown()
    }
    const begin = z.object({ frameId: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().parse(
      await this.#child.requestFrame({ operation: 'begin', context, frame, byteLength: payload.length }))
    try {
      for (let offset = 0; offset < payload.length; offset += 16_384) {
        const part = payload.subarray(offset, offset + 16_384)
        const received = z.object({ received: z.number().int() }).strict().parse(
          await this.#child.requestFrame({ operation: 'append', frameId: begin.frameId,
            offset, data: part.toString('base64') }))
        if (received.received !== offset + part.length) throw protectedDeliveryUnknown()
      }
      return begin.frameId
    } finally { payload.fill(0) }
  }
  /** Consume a fresh signed FRAME once; success follows the actual pipe write. */
  async commitFrame(input: T3ExecutionSignedAdmission): Promise<void> {
    const admission = T3ExecutionSignedAdmissionSchema.parse(input)
    const selected = T3ExecutionFrameAdmissionSchema.parse(JSON.parse(admission.payload))
    const result = z.object({ written: z.literal(true), frameId: z.string() }).strict().parse(
      await this.#child.requestFrame({ operation: 'commit', admission }))
    if (result.frameId !== selected.frameId) throw protectedDeliveryUnknown()
  }
  /** After association, stage exact bytes before requesting a fresh effect proof. */
  async stageEffectFrame(bytes: Uint8Array, metadata: T3ExecutionSerializedFrame,
    captured: T3ExecutionFrameContext): Promise<string> {
    const frameId = await this.#uploadFrame(bytes, metadata, captured)
    const result = z.object({ frameId: z.literal(frameId) }).strict().parse(
      await this.#child.requestFrame({ operation: 'stage', frameId }))
    return result.frameId
  }
  /** Graph-safe envelope: native independently checks the enrolled issuer and
   * actual association. A raw reference or serialized branding grants nothing. */
  async commitEffectFrame(frameId: string, input: T3EffectAuthorityChecked): Promise<void> {
    const proof = T3EffectAuthorityCheckedSchema.parse(input)
    const result = z.object({ written: z.literal(true), frameId: z.literal(frameId) }).strict().parse(
      await this.#child.requestFrame({ operation: 'commitEffect', frameId, proof }))
    if (result.frameId !== frameId) throw protectedDeliveryUnknown()
  }
  /** Only the service can construct the negative response; no JSON body input. */
  async refuseProviderRequest(protocolId: string | number): Promise<void> {
    z.object({ replied: z.literal(true) }).strict().parse(
      await this.#child.requestFrame({ operation: 'automaticReply', protocolId }))
  }
}
