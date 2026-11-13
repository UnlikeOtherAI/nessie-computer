import { createHash } from 'node:crypto'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3ExecutionFramePreparationPayloadSchema, T3ExecutionFrameAdmissionSchema,
  T3_EXECUTION_FRAME_PREPARATION_DOMAIN, type T3ExecutionPreparation, type T3ExecutionIssuerDescriptor,
  type T3ExecutionFrameContext, type T3ExecutionSerializedFrame,
  T3ExecutionAssociationPayloadSchema, T3_EXECUTION_ASSOCIATION_DOMAIN, T3EffectAuthorityCheckedSchema,
  type T3ExecutionReceipt, type T3ExecutionAssociation,
} from '@nessie/executor-protocol/t3-session'
import { verifyT3ExecutionReceiptSignature } from '../../t3-execution-native-client.js'
import type { ProtectedT3Provider } from '../../t3-protected-provider.js'
import type { T3NativeExecutionTransport } from '../../t3-native-execution-transport.js'
import { captureProviderFrameMetadata } from './frame-metadata.js'

const refused = () => new Error('T3_ORIGINAL_SERIALIZATION_REFUSED')
const sha = (bytes: Uint8Array | string) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
export interface CapturedProviderFrame {
  write(signal: AbortSignal): Promise<void>
  discard(): Promise<void>
}
export interface ProtectedProviderSerialization {
  capture(encoded: string): CapturedProviderFrame
  captureEffect(encoded: string): CapturedProviderFrame
  acceptAssociation(receipt: T3ExecutionReceipt): void
  refuse(protocolId: string | number): Promise<void>
  finishBootstrap(): Promise<void>
  close(): Promise<void>
}

/** Internal original-encoder adapter. The factory receives the preparation
 * observed by the actual service, never caller-selected method/id/hash metadata.
 * Each capture privately owns its exact bytes and command context BEFORE queue.
 * Every write still needs a fresh independently verified backend FRAME permit.
 * Bootstrap and associated frames retain their capture-time phase. Associated
 * writes stage the real bytes before obtaining a fresh existing effect proof.
 * Human replies still require their separate original answer authority. */
export function createProtectedProviderSerialization(provider: ProtectedT3Provider,
  transport: T3NativeExecutionTransport, issuer: T3ExecutionIssuerDescriptor,
  preparation: T3ExecutionPreparation, parent: AbortSignal): ProtectedProviderSerialization {
  if (preparation.processPurpose !== 'provider' || !['codex', 'claude'].includes(preparation.binding.driver)
    || canonicalExecutorJson(preparation.custody) !== canonicalExecutorJson(issuer.custody)) throw refused()
  const prepared = structuredClone(preparation)
  const capturedContext: Readonly<T3ExecutionFrameContext> = Object.freeze({
    correlationId: prepared.binding.correlationId, commandId: prepared.binding.commandId,
    requestDigest: prepared.binding.relayHmac, providerSessionId: prepared.providerSessionId,
  })
  const stop = new AbortController(), signal = AbortSignal.any([parent, stop.signal])
  const pending = new Set<Promise<unknown>>()
  const captures = new Set<{ discard(): Promise<void> }>()
  let mode: 'bootstrap' | 'associating' | 'associated' | 'closed' | 'failed' = 'bootstrap'
  let association: Readonly<T3ExecutionAssociation> | undefined
  let count = 0, buffered = 0
  const current = (required?: 'bootstrap' | 'associated' | 'associating') => {
    signal.throwIfAborted()
    if (mode === 'closed' || mode === 'failed' || required && mode !== required) throw refused()
  }
  const track = <A>(start: () => Promise<A>): Promise<A> => {
    const work = Promise.resolve().then(start)
    pending.add(work)
    void work.finally(() => pending.delete(work)).catch(() => undefined)
    return work
  }
  const capture = (encoded: string, phaseMode: 'bootstrap' | 'associated'): CapturedProviderFrame => {
    current(phaseMode)
    const bytes = Buffer.from(encoded, 'utf8')
    if (!bytes.length || bytes.length > 131_072 || bytes.at(-1) !== 10
      || bytes.subarray(0, -1).includes(10) || captures.size >= 8 || buffered + bytes.length > 262_144
      || count >= 4095) { bytes.fill(0); throw refused() }
    let frame: Readonly<T3ExecutionSerializedFrame>
    try { frame = captureProviderFrameMetadata(prepared.binding.driver, bytes) }
    catch { bytes.fill(0); throw refused() }
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
        mode = 'failed'
        stop.abort()
        await writing?.catch(() => undefined)
      }
      releaseBytes()
    } }
    captures.add(owner)
    const write = (cancellation: AbortSignal): Promise<void> => {
      current(phaseMode)
      cancellation.throwIfAborted()
      if (phase !== 'captured') throw refused()
      phase = 'writing'
      const cancel = () => { mode = 'failed'; stop.abort() }
      cancellation.addEventListener('abort', cancel, { once: true })
      writing = track(async () => {
        try {
          current(phaseMode)
          if (phaseMode === 'associated') {
            const actual = association
            if (!actual) throw refused()
            const frameId = await provider.stageEffectFrame(bytes, frame, capturedContext)
            current('associated')
            const proof = T3EffectAuthorityCheckedSchema.parse(await transport.effect(signal))
            current('associated')
            const grant = proof.grant
            if (grant.commandId !== capturedContext.commandId || grant.correlationId !== capturedContext.correlationId
              || grant.requestDigest !== capturedContext.requestDigest
              || grant.providerSessionId !== capturedContext.providerSessionId
              || grant.executorId !== prepared.binding.executorId
              || grant.environmentId !== prepared.binding.environmentId
              || grant.threadId !== prepared.binding.threadId
              || grant.connectionEpoch !== prepared.binding.connectionEpoch
              || grant.runtimeGeneration !== prepared.binding.runtimeGeneration
              || grant.nativeAssociation.driver !== prepared.binding.driver
              || grant.nativeAssociation.nativeId !== actual.nativeId
              || grant.nativeAssociation.continuationHomeKey !== prepared.binding.continuationHomeKey
              || grant.nativeAssociation.historyHomeKey !== prepared.binding.historyHomeKey
              || Date.parse(grant.expiresAt) <= Date.now()) throw refused()
            await provider.commitEffectFrame(frameId, proof)
          } else {
            const receipt = verifyT3ExecutionReceiptSignature(
              await provider.prepareFrame(bytes, frame, capturedContext), issuer)
            current('bootstrap')
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
            current('bootstrap')
            const admitted = T3ExecutionFrameAdmissionSchema.parse(JSON.parse(admission.payload))
            if (admitted.frameId !== observed.frameId || admitted.reservationId !== prepared.reservationId
              || admitted.providerSessionId !== prepared.providerSessionId
              || admitted.frameReceiptDigest !== sha(receipt.payload)
              || canonicalExecutorJson(admitted.frame) !== canonicalExecutorJson(frame)) throw refused()
            await provider.commitFrame(admission)
          }
          current(phaseMode)
          phase = 'written'
        } catch { mode = 'failed'; stop.abort(); throw refused() }
        finally { cancellation.removeEventListener('abort', cancel); releaseBytes() }
      })
      return writing
    }
    return Object.freeze({ write, discard: () => owner.discard() })
  }
  return Object.freeze<ProtectedProviderSerialization>({
    capture: encoded => capture(encoded, 'bootstrap'),
    captureEffect: encoded => capture(encoded, 'associated'),
    acceptAssociation(input) {
      current('associating')
      if (captures.size || pending.size) throw refused()
      const receipt = verifyT3ExecutionReceiptSignature(input, issuer)
      const actual = T3ExecutionAssociationPayloadSchema.parse(JSON.parse(receipt.payload))
      if (receipt.domain !== T3_EXECUTION_ASSOCIATION_DOMAIN || actual.reservationId !== prepared.reservationId
        || actual.providerSessionId !== prepared.providerSessionId || actual.launchDigest !== prepared.launchDigest
        || canonicalExecutorJson(actual.binding) !== canonicalExecutorJson(prepared.binding)
        || canonicalExecutorJson(actual.custody) !== canonicalExecutorJson(prepared.custody)) throw refused()
      association = Object.freeze(actual)
      mode = 'associated'
    },
    // Only native can construct the fixed unsupported response, from a real
    // outstanding stdout request. The caller supplies no JSON response body.
    refuse: (protocolId: string | number) => track(async () => {
      current()
      await provider.refuseProviderRequest(protocolId)
      current()
    }),
    /** Stop bootstrap writes before association is requested. Never reopen it. */
    async finishBootstrap(): Promise<void> {
      current('bootstrap')
      mode = 'associating'
      for (const owner of [...captures]) await owner.discard()
      while (pending.size) await Promise.allSettled([...pending])
      signal.throwIfAborted()
    },
    async close(): Promise<void> {
      mode = 'closed'
      stop.abort()
      for (const owner of [...captures]) await owner.discard()
      while (pending.size) await Promise.allSettled([...pending])
    },
  })
}
