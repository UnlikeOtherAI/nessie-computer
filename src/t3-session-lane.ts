import {
  decodeExecutorT3LaneOperation, encodeExecutorT3LaneReply, isExecutorT3Stream,
  isT3NativeLaunchOperation, T3_LANE_LIMITS,
  type ExecutorT3LaneDelivery,
  type T3ExecutionReceipt, type T3ExecutionSignedAdmission,
  T3InspectionRuntimeAnnouncementSchema, type T3InspectionRuntimeAnnouncement, type T3LaneInspectionAccepted,
  type ExecutorT3LaneOperation, type ExecutorT3LaneReply, type T3LaneFrame, type T3RuntimeAnnouncement,
} from '@nessie/executor-protocol/t3-session'
import { executorApi, type ExecutorApiClient } from './api-client.js'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'
import { snapshotT3LaneDelivery, t3LaneDeliveryExpiry } from './t3-session-delivery.js'
import { createT3InspectionPump } from './t3-session-inspections.js'
import { retainT3FiniteReply, T3FiniteReplyCapacityError, type T3RetainedFiniteReply } from './t3-finite-reply.js'

/** Supplied by the admitted runtime graph. This port conveys demand, never grants
 * source, provider or custody authority. The graph checks those before effects.
 * Aborting stops subscription/resource demand, not an already admitted turn.
 */
export interface T3SessionLaneRuntime {
  describe(): Promise<readonly T3RuntimeAnnouncement[]>;
  describeInspections?(): Promise<readonly T3InspectionRuntimeAnnouncement[]>;
  /** Nonexecuting demand. Only the service-registered held graph implements it;
   * retained lanes omit it. The native service verifies the backend signature.
   */
  inspect?(request: ExecutorT3LaneOperation, signal: AbortSignal,
    delivery: { inspection: T3ExecutionSignedAdmission; relayHmac: string;
      retentionExpiresAt: string }): Promise<T3ExecutionReceipt>;
  /** Retention notification only; reserve/open still need their own real authority. */
  acceptInspection?(request: ExecutorT3LaneOperation, accepted: T3LaneInspectionAccepted,
    signal: AbortSignal): Promise<void>;
  /** Abort has already fired. Join the actual held selection's finalizers. */
  releaseInspection?(inspectionId: string): Promise<void>;
  open(request: ExecutorT3LaneOperation, signal: AbortSignal,
    delivery: ExecutorT3LaneDelivery): AsyncIterable<ExecutorT3LaneReply>;
}
type State = Pick<ExecutorLocalState, 'apiBaseUrl' | 'executorId' | 'machinePrivateKey' | 'connectionEpoch'>
type Attempt = {
  request: ExecutorT3LaneOperation; iterator: AsyncIterator<ExecutorT3LaneReply>; abort: AbortController;
  ordinal: number; expiresAt: number; pending?: T3LaneFrame; bytes: number; pulling: boolean;
  delivery: ExecutorT3LaneDelivery;
  finite?: T3RetainedFiniteReply;
  expiryTimer?: ReturnType<typeof setTimeout>;
}
const key = (value: { environmentId: string; correlationId: string }) =>
  JSON.stringify([value.environmentId, value.correlationId])
const target = (request: ExecutorT3LaneOperation) => ({ environmentId: request.environmentId,
  correlationId: request.correlationId, runtimeGeneration: request.runtimeGeneration })

/** One in-memory, bounded exchange per daemon lease. No local transcript or
 * second receipt journal. An uncertain HTTP response retains the exact frame.
 */
export function createT3SessionLane(runtime: T3SessionLaneRuntime,
  api: Pick<ExecutorApiClient, 'exchangeT3SessionOperations'> = executorApi) {
  const attempts = new Map<string, Attempt>()
  const inspections = createT3InspectionPump(runtime)
  let connection: string | undefined
  let closed = false
  let exchanging: Promise<void> | null = null
  let buffered = 0
  const forget = (attempt: Attempt) => {
    if (attempts.get(key(attempt.request)) !== attempt) return
    clearTimeout(attempt.expiryTimer)
    attempts.delete(key(attempt.request))
    buffered -= attempt.bytes
    attempt.bytes = 0
    attempt.pending = undefined
    attempt.finite?.close()
    attempt.finite = undefined
    attempt.abort.abort()
    // An original pending stream pull may take time to observe cancellation.
    // Do not block the entire daemon's close/epoch transition on its return.
    void Promise.resolve(attempt.iterator.return?.()).catch(() => undefined)
  }
  const armExpiry = (attempt: Attempt) => {
    clearTimeout(attempt.expiryTimer)
    attempt.expiryTimer = setTimeout(() => { forget(attempt) }, Math.max(0, attempt.expiresAt - Date.now()))
    attempt.expiryTimer.unref()
  }
  const failure = (attempt: Attempt, capacity = false): ExecutorT3LaneReply => {
    const { request } = attempt
    return { kind: 'transport-error', transportVersion: request.transportVersion,
      protocolVersion: request.protocolVersion, sourceRevision: request.sourceRevision,
      executorId: request.executorId, environmentId: request.environmentId,
      connectionEpoch: request.connectionEpoch, runtimeGeneration: request.runtimeGeneration,
      correlationId: request.correlationId, relayOrdinal: attempt.ordinal,
      code: capacity ? 'capacity_exceeded' : request.kind === 'request' && request.commandId ? 'outcome_unknown' : 'offline' }
  }
  const pull = (attempt: Attempt) => {
    if (attempt.pulling || attempt.pending || attempt.abort.signal.aborted) return
    attempt.pulling = true
    void (async () => {
      let frame: T3LaneFrame
      try {
        if (!attempt.finite) {
          const next = await attempt.iterator.next()
          if (attempt.abort.signal.aborted) return
          if (next.done && !isExecutorT3Stream(attempt.request)) throw new Error('T3_EMPTY_FINITE_REPLY')
          const reply = next.done ? undefined : encodeExecutorT3LaneReply(next.value)
          if (reply && !isExecutorT3Stream(attempt.request)) {
            attempt.finite = retainT3FiniteReply(attempt.request, reply) ?? undefined
          }
          frame = { ...target(attempt.request), ordinal: attempt.ordinal,
            final: Boolean(next.done) || !isExecutorT3Stream(attempt.request)
              || !next.done && (next.value.kind === 'error' || next.value.kind === 'transport-error'),
            ...(reply === undefined ? {} : { reply }) }
        } else frame = { ...target(attempt.request), ordinal: attempt.ordinal, final: false }
        if (attempt.finite) {
          const fragment = attempt.finite.at(attempt.ordinal)
          frame = { ...target(attempt.request), ordinal: attempt.ordinal,
            final: fragment.index === fragment.count - 1, fragment }
        }
      } catch (error) {
        attempt.finite?.close()
        attempt.finite = undefined
        frame = { ...target(attempt.request), ordinal: attempt.ordinal, final: true,
          reply: encodeExecutorT3LaneReply(failure(attempt, error instanceof T3FiniteReplyCapacityError)) }
      }
      if (attempt.abort.signal.aborted) return
      let bytes = Buffer.byteLength(JSON.stringify(frame))
      if (frame.fragment && buffered + bytes > T3_LANE_LIMITS.bufferedBytes - 65_536) {
        return // Keep the exact held finite reply and wait for another credit poll.
      }
      // Keep space for a small terminal failure for each active request.
      if (bytes > T3_LANE_LIMITS.frameBytes - 16_384 || buffered + bytes > T3_LANE_LIMITS.bufferedBytes - 65_536) {
        frame = { ...target(attempt.request), ordinal: attempt.ordinal, final: true,
          reply: encodeExecutorT3LaneReply(failure(attempt)) }
        bytes = Buffer.byteLength(JSON.stringify(frame))
      }
      attempt.pending = frame
      attempt.bytes = bytes
      buffered += bytes
    })().finally(() => { attempt.pulling = false }).catch(() => { forget(attempt) })
  }
  const exchange = async (state: State) => {
    if (closed || !state.connectionEpoch) return
    const identity = JSON.stringify([state.apiBaseUrl, state.executorId, state.connectionEpoch])
    if (identity !== connection) {
      for (const attempt of attempts.values()) forget(attempt)
      await inspections.close()
      connection = identity
    }
    for (const attempt of attempts.values()) if (attempt.expiresAt <= Date.now()) forget(attempt)
    const frames: T3LaneFrame[] = []
    let bytes = 0
    for (const attempt of attempts.values()) {
      if (!attempt.pending || frames.length === T3_LANE_LIMITS.exchangeFrames) continue
      if (bytes + attempt.bytes > T3_LANE_LIMITS.frameBytes) continue
      frames.push(attempt.pending)
      bytes += attempt.bytes
    }
    const runtimes = await runtime.describe()
    const inspectionRuntimes = runtime.describeInspections
      ? (await runtime.describeInspections()).map(row => T3InspectionRuntimeAnnouncementSchema.parse(row)) : []
    if (inspectionRuntimes.length > T3_LANE_LIMITS.active) throw new Error('T3_LANE_CAPACITY')
    if (inspectionRuntimes.length && (!runtime.inspect || !runtime.acceptInspection || !runtime.releaseInspection)) {
      throw new Error('T3_EXECUTION_INSPECTION_UNBOUND')
    }
    const inspectionReceipts = inspections.frames()
    if (runtimes.length > T3_LANE_LIMITS.active) throw new Error('T3_LANE_CAPACITY')
    const payload = { operation: 't3.operations.exchange' as const, executorId: state.executorId,
      connectionEpoch: state.connectionEpoch, observedAt: new Date().toISOString(), frames,
      runtimes,
      inspectionRuntimes, inspectionReceipts,
      active: [...attempts.values()].map(attempt => target(attempt.request)) }
    const response = await api.exchangeT3SessionOperations(state.apiBaseUrl, { ...payload,
      signature: signExecutorDaemonPayload(state.machinePrivateKey, 't3_operations', payload) })
    if (closed || connection !== identity) return
    await inspections.accept(state.executorId, state.connectionEpoch, inspectionRuntimes,
      response.inspections ?? [], response.inspectionAcknowledged ?? [], inspectionReceipts,
      T3_LANE_LIMITS.active - attempts.size)
    if (!Array.isArray(response.acknowledged) || response.acknowledged.length > T3_LANE_LIMITS.exchangeFrames
      || !Array.isArray(response.offers) || response.offers.length > T3_LANE_LIMITS.exchangeFrames
      || !Array.isArray(response.controls) || response.controls.length > T3_LANE_LIMITS.active * 2) {
      throw new Error('T3_INVALID_LANE_RESPONSE')
    }
    for (const ack of response.acknowledged) {
      const attempt = attempts.get(key(ack))
      if (!attempt?.pending || attempt.pending.ordinal !== ack.ordinal
        || !frames.includes(attempt.pending)) throw new Error('T3_INVALID_FRAME_ACK')
      if (attempt.pending.final) { forget(attempt); continue }
      buffered -= attempt.bytes
      attempt.pending = undefined
      attempt.bytes = 0
      attempt.ordinal++
    }
    for (const control of response.controls) {
      const attempt = attempts.get(key(control))
      if (!attempt) continue
      if (control.state === 'cancel') { forget(attempt); continue }
      const expiry = Date.parse(control.expiresAt ?? '')
      if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + T3_LANE_LIMITS.leaseMs) {
        forget(attempt); continue
      }
      attempt.expiresAt = t3LaneDeliveryExpiry(attempt.delivery, expiry)
      if (attempt.expiresAt <= Date.now()) { forget(attempt); continue }
      armExpiry(attempt)
      if (control.state === 'credit' && control.nextOrdinal === attempt.ordinal) pull(attempt)
      else if (control.state !== 'hold') throw new Error('T3_INVALID_FRAME_CREDIT')
    }
    for (const offer of response.offers) {
      if (Buffer.byteLength(JSON.stringify(offer.request)) > T3_LANE_LIMITS.requestBytes) {
        throw new Error('T3_LANE_CAPACITY')
      }
      const request = decodeExecutorT3LaneOperation(offer.request)
      const delivery = snapshotT3LaneDelivery({ requestDigest: offer.requestDigest,
        ...(offer.provenance === undefined ? {} : { provenance: offer.provenance }),
        ...(offer.catalogLeases === undefined ? {} : { catalogLeases: offer.catalogLeases }),
        ...(offer.executionGraph === undefined ? {} : { executionGraph: offer.executionGraph }) }, request)
      if (request.executorId !== state.executorId || request.connectionEpoch !== state.connectionEpoch) {
        throw new Error('T3_LANE_CORRELATION')
      }
      const announced = isT3NativeLaunchOperation(request)
        ? inspectionRuntimes.some(row => row.environmentId === request.environmentId
          && row.runtimeGeneration === request.runtimeGeneration && row.sourceRevision === request.sourceRevision)
        : runtimes.some(row => row.state === 'ready' && row.environmentId === request.environmentId
          && row.runtimeGeneration === request.runtimeGeneration && row.sourceRevision === request.sourceRevision)
      if (!announced) throw new Error('T3_RUNTIME_UNAVAILABLE')
      const old = attempts.get(key(request))
      if (old) {
        if (old.request.runtimeGeneration !== request.runtimeGeneration
          || canonicalExecutorJson(old.delivery) !== canonicalExecutorJson(delivery)) {
          forget(old)
          throw new Error('T3_LANE_CORRELATION')
        }
        continue // Never invoke the engine twice for an already active offer.
      }
      if (attempts.size + inspections.size() >= T3_LANE_LIMITS.active) throw new Error('T3_LANE_CAPACITY')
      const expiresAt = t3LaneDeliveryExpiry(delivery, Date.parse(offer.expiresAt))
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()
        || expiresAt > Date.now() + T3_LANE_LIMITS.leaseMs) continue
      const abort = new AbortController()
      // Lazy adapter invocation: a synchronous runtime failure follows the same
      // terminal uncertainty path as a rejected Effect/stream pull.
      const iterator = (async function* () {
        yield* runtime.open(request, abort.signal, delivery)
      })()[Symbol.asyncIterator]()
      const attempt: Attempt = { request, iterator, abort, delivery, ordinal: 0, expiresAt, bytes: 0, pulling: false }
      attempts.set(key(request), attempt)
      armExpiry(attempt)
      pull(attempt)
    }
  }
  return {
    exchangeT3SessionOperations(state: State): Promise<void> {
      if (exchanging) return exchanging
      exchanging = exchange(state).finally(() => { exchanging = null })
      return exchanging
    },
    hot: () => attempts.size > 0 || inspections.size() > 0,
    async close() {
      closed = true
      for (const attempt of attempts.values()) forget(attempt)
      await inspections.close()
    },
  }
}
