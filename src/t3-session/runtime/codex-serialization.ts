import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import { CodexErrors, type CodexSerializedOutput, type CodexCapturedWrite }
  from '@nessie/t3-session-source/engine'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3ExecutionFramePreparationPayloadSchema, T3ExecutionFrameAdmissionSchema,
  T3_EXECUTION_FRAME_PREPARATION_DOMAIN, type T3ExecutionPreparation, type T3ExecutionIssuerDescriptor,
  type T3ExecutionFrameContext, type T3ExecutionSerializedFrame,
} from '@nessie/executor-protocol/t3-session'
import { verifyT3ExecutionReceiptSignature } from '../../t3-execution-native-client.js'
import type { ProtectedT3Provider } from '../../t3-protected-provider.js'
import type { T3NativeExecutionTransport } from '../../t3-native-execution-transport.js'
import { joinedNativeEffect } from './native-effect.js'

const refused = () => new CodexErrors.CodexAppServerTransportError({
  operation: 'write-output-stream', cause: new Error('T3_ORIGINAL_SERIALIZATION_REFUSED'),
})
const sha = (bytes: Uint8Array | string) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
export interface ProtectedCodexSerialization {
  readonly output: CodexSerializedOutput
  finishBootstrap(): Promise<void>
  close(): Promise<void>
}

/** Internal original-encoder adapter. The factory receives the preparation
 * observed by the actual service, never caller-selected method/id/hash metadata.
 * Each capture privately owns its exact bytes and command context BEFORE queue.
 * Every write still needs a fresh independently verified backend FRAME permit.
 * This bootstrap adapter cannot write after association or send human replies. */
export function createProtectedCodexSerialization(provider: ProtectedT3Provider,
  transport: T3NativeExecutionTransport, issuer: T3ExecutionIssuerDescriptor,
  preparation: T3ExecutionPreparation, parent: AbortSignal): ProtectedCodexSerialization {
  if (preparation.processPurpose !== 'provider' || preparation.binding.driver !== 'codex'
    || canonicalExecutorJson(preparation.custody) !== canonicalExecutorJson(issuer.custody)) throw refused()
  const prepared = structuredClone(preparation)
  const capturedContext: Readonly<T3ExecutionFrameContext> = Object.freeze({
    correlationId: prepared.binding.correlationId, commandId: prepared.binding.commandId,
    requestDigest: prepared.binding.relayHmac, providerSessionId: prepared.providerSessionId,
  })
  const stop = new AbortController(), signal = AbortSignal.any([parent, stop.signal])
  const pending = new Set<Promise<unknown>>()
  const captures = new Set<{ discard(): Promise<void> }>()
  let accepting = true, count = 0, buffered = 0
  const current = () => { signal.throwIfAborted(); if (!accepting) throw refused() }
  const track = <A>(start: () => Promise<A>): Promise<A> => {
    const work = Promise.resolve().then(start)
    pending.add(work)
    void work.finally(() => pending.delete(work)).catch(() => undefined)
    return work
  }
  const capture = (encoded: string): CodexCapturedWrite => {
    current()
    const bytes = Buffer.from(encoded, 'utf8')
    if (!bytes.length || bytes.length > 131_072 || bytes.at(-1) !== 10
      || bytes.subarray(0, -1).includes(10) || captures.size >= 8 || buffered + bytes.length > 262_144
      || count >= 4095) { bytes.fill(0); throw refused() }
    let frame: Readonly<T3ExecutionSerializedFrame>
    try {
      const message: unknown = JSON.parse(encoded)
      if (!message || typeof message !== 'object' || !('method' in message)
        || typeof message.method !== 'string' || 'result' in message || 'error' in message) throw refused()
      const protocolId = 'id' in message ? message.id : undefined
      if (protocolId !== undefined && !(typeof protocolId === 'string' && protocolId.length > 0)
        && !(typeof protocolId === 'number' && Number.isSafeInteger(protocolId))) throw refused()
      frame = Object.freeze({ driver: 'codex', kind: protocolId === undefined ? 'notification' : 'request',
        method: message.method, ...(protocolId === undefined ? {} : { protocolId: protocolId as string | number }),
        frameSha256: sha(bytes) })
    } catch { bytes.fill(0); throw refused() }
    count++
    buffered += bytes.length
    let phase: 'captured' | 'writing' | 'written' | 'discarded' = 'captured'
    let writing: Promise<void> | undefined
    let released = false
    const releaseBytes = () => {
      if (released) return
      released = true
      buffered -= bytes.length
      bytes.fill(0)
      captures.delete(owner)
    }
    const owner = { async discard() {
      if (phase === 'captured') phase = 'discarded'
      if (phase === 'writing') {
        // Interrupted enqueue cannot leave an unjoined write with a live grant.
        accepting = false
        stop.abort()
        await writing?.catch(() => undefined)
      }
      releaseBytes()
    } }
    captures.add(owner)
    const write = joinedNativeEffect(cancellation => {
      current()
      cancellation.throwIfAborted()
      if (phase !== 'captured') throw refused()
      phase = 'writing'
      const cancel = () => { accepting = false; stop.abort() }
      cancellation.addEventListener('abort', cancel, { once: true })
      writing = track(async () => {
        try {
          current()
          const receipt = verifyT3ExecutionReceiptSignature(
            await provider.prepareFrame(bytes, frame, capturedContext), issuer)
          current()
          const observed = T3ExecutionFramePreparationPayloadSchema.parse(JSON.parse(receipt.payload))
          if (receipt.domain !== T3_EXECUTION_FRAME_PREPARATION_DOMAIN
            || observed.reservationId !== prepared.reservationId
            || observed.providerSessionId !== prepared.providerSessionId
            || observed.launchDigest !== prepared.launchDigest
            || canonicalExecutorJson(observed.binding) !== canonicalExecutorJson(prepared.binding)
            || canonicalExecutorJson(observed.custody) !== canonicalExecutorJson(prepared.custody)
            || canonicalExecutorJson(observed.frame) !== canonicalExecutorJson(frame)) throw refused()
          const admission = await transport.frame({ reservationId: prepared.reservationId,
            frameReceipt: receipt }, signal)
          current()
          const admitted = T3ExecutionFrameAdmissionSchema.parse(JSON.parse(admission.payload))
          if (admitted.frameId !== observed.frameId || admitted.reservationId !== prepared.reservationId
            || admitted.providerSessionId !== prepared.providerSessionId
            || admitted.frameReceiptDigest !== sha(receipt.payload)
            || canonicalExecutorJson(admitted.frame) !== canonicalExecutorJson(frame)) throw refused()
          await provider.commitFrame(admission)
          current()
          phase = 'written'
        } catch { accepting = false; stop.abort(); throw refused() }
        finally { cancellation.removeEventListener('abort', cancel); releaseBytes() }
      })
      return writing
    }, refused)
    return Object.freeze({ write, discard: Effect.promise(() => owner.discard()) })
  }
  const output: CodexSerializedOutput = Object.freeze({
    capture: encoded => Effect.try({ try: () => capture(encoded), catch: refused }),
    // No error body is accepted. Native requires an actual outstanding request
    // observed on provider stdout and builds only its fixed unsupported answer.
    refuse: protocolId => joinedNativeEffect(() => track(async () => {
      current()
      await provider.refuseProviderRequest(protocolId)
      current()
    }), refused),
  })
  return Object.freeze({
    output,
    /** Stop bootstrap writes before association is requested. Never reopen it. */
    async finishBootstrap(): Promise<void> {
      current()
      accepting = false
      for (const owner of [...captures]) await owner.discard()
      while (pending.size) await Promise.allSettled([...pending])
      signal.throwIfAborted()
    },
    async close(): Promise<void> {
      accepting = false
      stop.abort()
      for (const owner of [...captures]) await owner.discard()
      while (pending.size) await Promise.allSettled([...pending])
    },
  })
}
