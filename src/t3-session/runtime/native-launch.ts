import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3ExecutionAdmissionSchema, T3ExecutionReservationPayloadSchema, T3ExecutionPreparationPayloadSchema,
  T3ExecutionAssociationPayloadSchema, T3ExecutionGraphPayloadSchema,
  type ExecutorT3Request, type ExecutorT3LaneDelivery, type T3ExecutionBinding,
  type T3ExecutionPreparation, type T3ExecutionReceipt,
} from '@nessie/executor-protocol/t3-session'
import { createT3ExecutionNativeClient, type T3NativeLaunchDescriptor } from '../../t3-execution-native-client.js'
import { startProtectedT3Provider } from '../../t3-protected-process.js'
import type { ProtectedT3Provider } from '../../t3-protected-provider.js'
import type { T3NativeExecutionTransport } from '../../t3-native-execution-transport.js'
import type { HeldSessionInspectionRuntime } from './inspection-runtime.js'
import type { PreparedSessionLaunchTarget } from './launch-target.js'
import { createProtectedCodexSerialization, type ProtectedCodexSerialization } from './codex-serialization.js'
import { protectedRuntimeRefused } from './protected-wire.js'
import type { ScopedSessionSecretReadAttempts } from './secret-read-attempts.js'
import type { SessionLaunchCommandLineage } from './command-lineage.js'
import { makeSessionPreclaimHost } from './effect-preclaims.js'

type Request = Extract<ExecutorT3Request, { readonly method: 'orchestration.launchThread' }>
type ProviderLaunch = Extract<T3NativeLaunchDescriptor, { processPurpose: 'provider' }>
const sha = (value: string) => 'sha256:' + createHash('sha256').update(value, 'utf8').digest('hex')
export interface HeldNativeSessionProvider {
  readonly process: ProtectedT3Provider
  readonly signal: AbortSignal
  readonly preparation: Readonly<T3ExecutionPreparation>
  readonly serialization: ProtectedCodexSerialization
  /** Call after original protocol bootstrap observes its provider session.
   * Native associates ONLY its own held stdout observation, never an argument. */
  associate(): Promise<T3ExecutionReceipt>
}
export interface ReservedSessionLaunch {
  readonly target: PreparedSessionLaunchTarget
  readonly signal: AbortSignal
  readonly binding: Readonly<T3ExecutionBinding>
  /** Replay refusal only; reserve does not authorize secret reads. */
  readonly secretReadAttempts: ScopedSessionSecretReadAttempts
  /** Original command/run relationships only; this is not effect or process authority. */
  readonly commandLineage: SessionLaunchCommandLineage
  /** Internal original-adapter seam, after separately authorized preparation.
   * Does not hydrate settings, allocate IDs, perform workspace effects or infer
   * a launch descriptor from the original launchThread input. */
  withProvider<A>(providerSessionId: string, launch: ProviderLaunch,
    use: (provider: HeldNativeSessionProvider) => Promise<A>): Promise<A>
}

/** Same accepted original target and engine scope through the finite native
 * phases. This transport is not a workspace/secret preparation grant. The
 * original activated adapter must supply its own actual allocated session ID
 * and process descriptor AFTER those preparation effects are admitted.
 * Currently Codex only; Claude SDK/history remain explicitly unbound. */
export async function withReservedSessionLaunch<A>(held: HeldSessionInspectionRuntime,
  request: Request, delivery: ExecutorT3LaneDelivery, transport: T3NativeExecutionTransport,
  caller: AbortSignal, use: (launch: ReservedSessionLaunch) => Promise<A>): Promise<A> {
  return held.withRecognized(request, delivery, caller, async (target, parent, accepted, secretReadAttempts) => {
    if (target.driver !== 'codex' || !delivery.executionGraph) throw protectedRuntimeRefused()
    const stop = new AbortController(), signal = AbortSignal.any([parent, stop.signal])
    const graph = T3ExecutionGraphPayloadSchema.parse(JSON.parse(delivery.executionGraph.payload))
    let live = true, launched = false
    let failure: unknown
    const pending = new Set<Promise<unknown>>()
    const recheck = async () => {
      signal.throwIfAborted()
      if (!live) throw protectedRuntimeRefused()
      await Effect.runPromise(held.original.recheck)
      signal.throwIfAborted()
    }
    await recheck()
    const native = await createT3ExecutionNativeClient(request.executorId, signal)
    if (canonicalExecutorJson(native.descriptor.custody) !== canonicalExecutorJson(graph.custody)) {
      throw protectedRuntimeRefused()
    }
    const signed = await transport.phase({ phase: 'reserve', graphId: accepted.graphId }, signal)
    const reserve = T3ExecutionAdmissionSchema.parse(JSON.parse(signed.payload))
    if (reserve.phase !== 'reserve' || reserve.issuerKeyId !== native.descriptor.keyId
      || reserve.releaseDigest !== graph.custody.releaseDigest
      || Object.entries(graph.binding).some(([key, value]) =>
        reserve.binding[key as keyof T3ExecutionBinding] !== value)) {
      throw protectedRuntimeRefused()
    }
    await recheck()
    const reservationReceipt = await native.reserve(signed, signal)
    const reservation = T3ExecutionReservationPayloadSchema.parse(JSON.parse(reservationReceipt.payload))
    if (reservation.reservationId !== reserve.reservationId || reservation.admissionDigest !== sha(signed.payload)
      || canonicalExecutorJson(reservation.binding) !== canonicalExecutorJson(reserve.binding)
      || canonicalExecutorJson(reservation.custody) !== canonicalExecutorJson(native.descriptor.custody)) {
      throw protectedRuntimeRefused()
    }
    await transport.receipt(reservationReceipt, signal)
    await recheck()
    return held.original.withCommandLineageCapture(graph, Date.parse(accepted.expiresAt), parent, async sink => {
      const commandLineage = held.original.commandLineage.register(reserve.binding, recheck, signal, sink)
      const preclaims = makeSessionPreclaimHost(held.original.executionSource, graph, reserve.binding,
        native.descriptor, transport, commandLineage, signal)
      try { held.original.commandLineage.bindPreclaims(commandLineage, preclaims) }
      catch (error) { commandLineage.close(); stop.abort(); await preclaims.close(); throw error }
      const launchProvider = async <T>(providerSessionId: string, launch: ProviderLaunch,
        callback: (provider: HeldNativeSessionProvider) => Promise<T>): Promise<T> => {
        await recheck()
        if (launched || launch.processPurpose !== 'provider') throw protectedRuntimeRefused()
        launched = true // Ambiguous preparation/spawn cannot retry this reservation.
        const preparationReceipt = await native.prepare(reserve.reservationId, providerSessionId, launch, signal)
        const preparation = T3ExecutionPreparationPayloadSchema.parse(JSON.parse(preparationReceipt.payload))
        if (preparation.processPurpose !== 'provider' || preparation.providerSessionId !== providerSessionId
          || preparation.reservationId !== reserve.reservationId || preparation.admissionDigest !== sha(signed.payload)
          || canonicalExecutorJson(preparation.binding) !== canonicalExecutorJson(reserve.binding)
          || canonicalExecutorJson(preparation.custody) !== canonicalExecutorJson(native.descriptor.custody)) {
          throw protectedRuntimeRefused()
        }
        await recheck()
        const admitted = await transport.phase({ phase: 'launch', reservationId: reserve.reservationId,
          preparationReceipt }, signal)
        const phase = T3ExecutionAdmissionSchema.parse(JSON.parse(admitted.payload))
        if (phase.phase !== 'launch' || phase.processPurpose !== 'provider'
          || phase.reservationId !== reserve.reservationId || phase.launchDigest !== preparation.launchDigest
          || canonicalExecutorJson(phase.binding) !== canonicalExecutorJson(reserve.binding)) {
          throw protectedRuntimeRefused()
        }
        await recheck()
        const process = await startProtectedT3Provider(admitted, signal)
        let serialization: ProtectedCodexSerialization | undefined
        let association: Promise<T3ExecutionReceipt> | undefined
        try {
          await recheck()
          serialization = createProtectedCodexSerialization(process, transport, native.descriptor, preparation, signal)
          const originalSerialization = serialization
          const associate = () => {
            if (association) return association
            association = (async () => {
              await originalSerialization.finishBootstrap()
              await recheck()
              const permission = await transport.phase({ phase: 'associate', reservationId: reserve.reservationId,
                providerSessionId }, signal)
              const receipt = await native.associate(permission, signal)
              const actual = T3ExecutionAssociationPayloadSchema.parse(JSON.parse(receipt.payload))
              if (actual.providerSessionId !== providerSessionId || actual.reservationId !== reserve.reservationId
                || actual.launchDigest !== preparation.launchDigest
                || canonicalExecutorJson(actual.binding) !== canonicalExecutorJson(reserve.binding)) {
                throw protectedRuntimeRefused()
              }
              await transport.receipt(receipt, signal)
              await recheck()
              return receipt
            })()
            void association.catch(error => { failure ??= error; stop.abort() })
            return association
          }
          return await callback(Object.freeze({ process, signal, preparation: Object.freeze(preparation),
            serialization, associate }))
        } finally {
          // Callback return withdraws this finite launch. Writes and association
          // must finish before service-positive provider Job clearance, then SQL.
          stop.abort()
          try { await serialization?.close(); await association?.catch(() => undefined) }
          finally { await process.terminate(); await process.closed }
        }
      }
      try {
        return await use(Object.freeze({ target, signal, binding: Object.freeze(structuredClone(reserve.binding)),
          secretReadAttempts, commandLineage,
          withProvider: <T>(providerSessionId: string, launch: ProviderLaunch,
            callback: (provider: HeldNativeSessionProvider) => Promise<T>) => {
            const work = launchProvider(providerSessionId, structuredClone(launch), callback)
            pending.add(work)
            void work.catch(error => { failure ??= error }).finally(() => pending.delete(work))
            return work
          },
        }))
      } finally {
        live = false
        stop.abort()
        commandLineage.close()
        await preclaims.close()
        while (pending.size) await Promise.allSettled([...pending])
        if (failure) throw failure
      }
    })
  })
}
