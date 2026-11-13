import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import { SessionLifecycleActionRefused, type SessionLifecycleAuthority } from '@nessie/t3-session-source/engine'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3ExecutionShutdownPreparationPayloadSchema, T3ExecutionShutdownAdmissionSchema,
  T3_EXECUTION_SHUTDOWN_PREPARATION_DOMAIN, type T3ExecutionBinding, type T3ExecutionGraph,
  type T3ExecutionIssuerDescriptor } from '@nessie/executor-protocol/t3-session'
import { verifyT3ExecutionReceiptSignature } from '../../t3-execution-native-client.js'
import type { T3NativeExecutionTransport } from '../../t3-native-execution-transport.js'
import { recognizeT3ExecutionResource, type T3ExecutionResourceScope } from '../source/execution.js'
import { joinedNativeEffect } from './native-effect.js'

type Owner = Pick<SessionLifecycleAuthority['Service'], 'withShutdownPreparation'>
export interface SessionShutdownHost extends Owner {
  readonly signal: AbortSignal
  close(): Promise<void>
}
const refused = () => new SessionLifecycleActionRefused()
const sha = (value: string) => 'sha256:' + createHash('sha256').update(value, 'utf8').digest('hex')
/** Only this complete action, in the same original graph and actual captured
 * command port. It supplies none of the other required lifecycle permissions. */
export function makeSessionShutdownHost(source: T3ExecutionResourceScope, graph: T3ExecutionGraph,
  binding: T3ExecutionBinding, descriptor: T3ExecutionIssuerDescriptor, transport: T3NativeExecutionTransport,
  parent: AbortSignal): SessionShutdownHost {
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
  const withShutdownPreparation: Owner['withShutdownPreparation'] = (candidate, write) =>
    Effect.suspend(() => {
      const authorityDigest = candidate.authorityDigest, targets = candidate.projectionInputs
      const effects = candidate.effects
      const notAfterMs = candidate.observedAtMs + 5000, originalMonotonic = candidate.notAfterMonotonicMs
      let resolve!: () => void
      const completion = new Promise<void>(done => { resolve = done })
      pending.add(completion)
      const work = Effect.gen(function* () {
        const permission = yield* joinedNativeEffect(async cancellation => {
          const demand = AbortSignal.any([signal, cancellation])
          await current(); demand.throwIfAborted()
          const receipt = verifyT3ExecutionReceiptSignature(
            await source.prepareShutdown(graph, candidate.observedAtMs), descriptor)
          const prepared = T3ExecutionShutdownPreparationPayloadSchema.parse(JSON.parse(receipt.payload))
          if (receipt.domain !== T3_EXECUTION_SHUTDOWN_PREPARATION_DOMAIN
            || canonicalExecutorJson(prepared.binding) !== canonicalExecutorJson(binding)
            || prepared.acceptedGraphNonce !== graph.nonce || prepared.observation.authorityDigest !== authorityDigest
            || prepared.observation.selectionAtMs !== candidate.observedAtMs
            || canonicalExecutorJson(prepared.observation.targets) !== canonicalExecutorJson(targets)
            || canonicalExecutorJson(prepared.observation.effects) !== canonicalExecutorJson(effects)
            || prepared.expiresAtMs > notAfterMs) throw refused()
          await current(); demand.throwIfAborted()
          const signed = await transport.prepareShutdown({ preparationReceipt: receipt }, demand)
          const admitted = T3ExecutionShutdownAdmissionSchema.parse(JSON.parse(signed.payload))
          const { issuerKeyId, preparationReceiptDigest, ...observed } = admitted
          if (issuerKeyId !== descriptor.keyId || preparationReceiptDigest !== sha(receipt.payload)
            || admitted.issuedAtMs < prepared.issuedAtMs || admitted.expiresAtMs > prepared.expiresAtMs
            || canonicalExecutorJson({ ...observed, nonce: prepared.nonce,
              issuedAtMs: prepared.issuedAtMs, expiresAtMs: prepared.expiresAtMs })
              !== canonicalExecutorJson(prepared)) {
            throw refused()
          }
          await current(); demand.throwIfAborted()
          const started = performance.now()
          const consumed = await source.consumeShutdown(graph, signed)
          await current(); demand.throwIfAborted()
          if (consumed.slotId !== prepared.slotId || consumed.authorityDigest !== authorityDigest
            || consumed.notAfterMs !== admitted.expiresAtMs) throw refused()
          const notAfterMonotonicMs = Math.min(originalMonotonic, started + consumed.remainingMs,
            performance.now() + consumed.notAfterMs - Date.now())
          if (notAfterMonotonicMs <= performance.now() || consumed.notAfterMs <= Date.now()) throw refused()
          return { notAfterMs: consumed.notAfterMs, notAfterMonotonicMs }
        }, refused)
        yield* Effect.try({ try: () => signal.throwIfAborted(), catch: refused })
        return yield* write(permission)
      })
      const cancelled = Effect.callback<never, SessionLifecycleActionRefused>(resume => {
        const abort = () => resume(Effect.fail(refused()))
        if (signal.aborted) { abort(); return }
        signal.addEventListener('abort', abort, { once: true })
        return Effect.sync(() => signal.removeEventListener('abort', abort))
      })
      return Effect.raceFirst(work, cancelled).pipe(
        Effect.ensuring(Effect.sync(() => { pending.delete(completion); resolve() })))
    })
  return Object.freeze({ signal, withShutdownPreparation, async close() {
    live = false; stop.abort()
    while (pending.size) await Promise.allSettled([...pending])
  } })
}
