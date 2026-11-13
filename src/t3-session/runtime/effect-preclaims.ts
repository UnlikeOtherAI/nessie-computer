import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import { EffectClaims } from '@nessie/t3-session-source/engine'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3ExecutionPreclaimPreparationPayloadSchema, T3ExecutionPreclaimAdmissionSchema,
  T3_EXECUTION_PRECLAIM_PREPARATION_DOMAIN, type T3ExecutionBinding, type T3ExecutionGraph,
  type T3ExecutionIssuerDescriptor } from '@nessie/executor-protocol/t3-session'
import { verifyT3ExecutionReceiptSignature } from '../../t3-execution-native-client.js'
import type { T3NativeExecutionTransport } from '../../t3-native-execution-transport.js'
import { recognizeT3ExecutionResource, type T3ExecutionResourceScope } from '../source/execution.js'
import type { SessionLaunchCommandLineage } from './command-lineage.js'
import { joinedNativeEffect } from './native-effect.js'

type Claims = EffectClaims.SessionEffectClaimAuthority['Service']
export interface SessionPreclaimHost {
  readonly signal: AbortSignal
  readonly withClaim: Claims['withClaim']
  close(): Promise<void>
}
const refused = () => new EffectClaims.SessionEffectClaimRefused()
const issued = new WeakSet<SessionPreclaimHost>()
export const recognizeSessionPreclaimHost = (host: SessionPreclaimHost): void => {
  if (!issued.has(host) || host.signal.aborted) throw refused()
}
const sha = (value: string) => 'sha256:' + createHash('sha256').update(value, 'utf8').digest('hex')
/** One captured original operation, actual issued resource and daemon port.
 * Only native consumption can precede this exact original conditional callback. */
export function makeSessionPreclaimHost(source: T3ExecutionResourceScope, graph: T3ExecutionGraph,
  binding: T3ExecutionBinding, descriptor: T3ExecutionIssuerDescriptor, transport: T3NativeExecutionTransport,
  lineage: SessionLaunchCommandLineage, parent: AbortSignal): SessionPreclaimHost {
  const stop = new AbortController(), signal = AbortSignal.any([parent, source.signal, stop.signal])
  const pending = new Set<Promise<void>>()
  let live = true
  const current = async () => {
    signal.throwIfAborted()
    if (!live) throw refused()
    const resource = await recognizeT3ExecutionResource(source)
    if (canonicalExecutorJson(resource.custody) !== canonicalExecutorJson(descriptor.custody)
      || canonicalExecutorJson(graph.custody) !== canonicalExecutorJson(descriptor.custody)) throw refused()
    signal.throwIfAborted()
  }
  const withClaim: Claims['withClaim'] = (candidate, claim) => Effect.suspend(() => {
    let resolve!: () => void
    const completion = new Promise<void>(done => { resolve = done })
    pending.add(completion)
    const program = Effect.gen(function* () {
      const effect = candidate.effect, rowDigest = candidate.rowDigest
      yield* lineage.assertProviderTurnStart(effect).pipe(Effect.mapError(refused))
      const started = performance.now()
      const permission = yield* joinedNativeEffect(async cancellation => {
        const demand = AbortSignal.any([signal, cancellation])
        await current(); demand.throwIfAborted()
        const receipt = verifyT3ExecutionReceiptSignature(await source.prepareEffectClaim(graph, effect.id), descriptor)
        const observed = T3ExecutionPreclaimPreparationPayloadSchema.parse(JSON.parse(receipt.payload))
        if (receipt.domain !== T3_EXECUTION_PRECLAIM_PREPARATION_DOMAIN
          || canonicalExecutorJson(observed.binding) !== canonicalExecutorJson(binding)
          || observed.acceptedGraphNonce !== graph.nonce || observed.bound.observation.effectId !== effect.id
          || observed.bound.observation.rowDigest !== rowDigest
          || observed.bound.observation.attemptCount !== effect.attemptCount) throw refused()
        await current(); demand.throwIfAborted()
        const signed = await transport.preclaim({ preparationReceipt: receipt }, demand)
        const admission = T3ExecutionPreclaimAdmissionSchema.parse(JSON.parse(signed.payload))
        if (admission.claimId !== observed.claimId || admission.issuerKeyId !== descriptor.keyId
          || admission.preparationReceiptDigest !== sha(receipt.payload)
          || canonicalExecutorJson(admission.binding) !== canonicalExecutorJson(binding)) throw refused()
        await current(); demand.throwIfAborted()
        const consumeStarted = performance.now()
        const consumed = await source.consumeEffectClaim(graph, signed)
        await current(); demand.throwIfAborted()
        if (consumed.claimId !== observed.claimId || consumed.effectId !== effect.id || consumed.rowDigest !== rowDigest
          || consumed.notAfterMs !== admission.expiresAtMs || candidate.rowDigest !== rowDigest) throw refused()
        const monotonic = Math.min(started + 5000, consumeStarted + consumed.remainingMs,
          performance.now() + consumed.notAfterMs - Date.now())
        if (monotonic <= performance.now()) throw refused()
        return { notAfterMs: consumed.notAfterMs, notAfterMonotonicMs: monotonic }
      }, refused)
      yield* lineage.assertProviderTurnStart(effect).pipe(Effect.mapError(refused))
      yield* Effect.try({ try: () => signal.throwIfAborted(), catch: refused })
      return yield* claim(permission)
    })
    const cancelled = Effect.callback<never, EffectClaims.SessionEffectClaimRefused>(resume => {
      const abort = () => resume(Effect.fail(refused()))
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      return Effect.sync(() => signal.removeEventListener('abort', abort))
    })
    // Interrupt and join the original SQL Effect as well as the native/HTTP
    // preparation. A stopped owner cannot leave a connection waiter detached.
    return Effect.raceFirst(program, cancelled).pipe(
      Effect.ensuring(Effect.sync(() => { pending.delete(completion); resolve() })))
  })
  const host = Object.freeze({ signal, withClaim, async close() {
    live = false; stop.abort()
    while (pending.size) await Promise.allSettled([...pending])
  } })
  issued.add(host)
  return host
}
