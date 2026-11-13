import { createHash } from 'node:crypto'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3ExecutionInspectionSchema, T3ExecutionReceiptSchema, T3_EXECUTION_GRAPH_DOMAIN,
  T3ExecutionSignedAdmissionSchema, decodeExecutorT3LaneOperation, encodeExecutorT3LaneOperation,
  T3LaneInspectionAcceptedSchema, isT3NativeLaunchOperation, T3_LANE_LIMITS,
  type T3LaneInspection, type T3LaneInspectionReceipt, type T3InspectionRuntimeAnnouncement,
  type T3LaneInspectionAccepted, type ExecutorT3LaneOperation,
} from '@nessie/executor-protocol/t3-session'
import type { T3SessionLaneRuntime } from './t3-session-lane.js'

type Job = { wire: string; request: ExecutorT3LaneOperation;
  challenge: ReturnType<typeof T3ExecutionInspectionSchema.parse>;
  abort: AbortController; done: Promise<void>; expiresAt: number;
  receipt?: T3LaneInspectionReceipt; accepted?: T3LaneInspectionAccepted;
  accepting?: Promise<void>; closing?: Promise<void>; timer?: ReturnType<typeof setTimeout> }
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')

/** The same parent signal survives accepted receipt cleanup. Neither acceptance
 * metadata nor these lifecycle methods grants an effect or retained-read slot.
 */
export function createT3InspectionPump(runtime: T3SessionLaneRuntime) {
  const jobs = new Map<string, Job>()
  let cleanupError: unknown
  let lifecycle = 0
  const forget = (id: string, job: Job): Promise<void> => {
    if (job.closing) return job.closing
    clearTimeout(job.timer)
    job.abort.abort()
    job.closing = (async () => {
      await job.done
      await job.accepting?.catch(() => undefined)
      await runtime.releaseInspection?.(id)
    })().finally(() => { if (jobs.get(id) === job) jobs.delete(id) })
    void job.closing.catch(error => { cleanupError = error })
    return job.closing
  }
  const arm = (id: string, job: Job) => {
    clearTimeout(job.timer)
    job.timer = setTimeout(() => { void forget(id, job) }, Math.max(0, job.expiresAt - Date.now()))
    job.timer.unref()
  }
  return {
    size: () => jobs.size,
    hasAccepted(request: ExecutorT3LaneOperation): boolean {
      const requestSha256 = 'sha256:' + createHash('sha256')
        .update(JSON.stringify(encodeExecutorT3LaneOperation(request)), 'utf8').digest('hex')
      return [...jobs.values()].some(job => !job.abort.signal.aborted && job.expiresAt > Date.now()
        && job.accepted?.requestSha256 === requestSha256 && job.accepted.executorId === request.executorId
        && job.accepted.environmentId === request.environmentId && job.accepted.correlationId === request.correlationId
        && job.accepted.runtimeGeneration === request.runtimeGeneration)
    },
    frames(): T3LaneInspectionReceipt[] {
      return [...jobs.values()].flatMap(job => !job.abort.signal.aborted && job.receipt
        && !job.accepted && job.expiresAt > Date.now() ? [job.receipt] : []).slice(0, T3_LANE_LIMITS.exchangeFrames)
    },
    async close() {
      lifecycle++
      await Promise.all([...jobs].map(([id, job]) => forget(id, job)))
      if (cleanupError) throw cleanupError
    },
    async accept(executorId: string, epoch: string, runtimes: readonly T3InspectionRuntimeAnnouncement[],
      offers: readonly T3LaneInspection[], acknowledged: readonly T3LaneInspectionAccepted[],
      sent: readonly T3LaneInspectionReceipt[], remaining: number) {
      const generation = lifecycle
      if (cleanupError) throw cleanupError
      if (offers.length > T3_LANE_LIMITS.exchangeFrames || acknowledged.length > T3_LANE_LIMITS.exchangeFrames) {
        throw new Error('T3_LANE_CAPACITY')
      }
      const available = (job: Job) => runtimes.some(row => row.role === 'source-inspection'
        && row.environmentId === job.request.environmentId && row.runtimeGeneration === job.request.runtimeGeneration
        && row.sourceRevision === job.request.sourceRevision && row.physicalRootKey === job.challenge.sourceRootKey
        && row.captureGeneration === job.challenge.sourceGeneration)
      for (const [id, job] of jobs) if (!available(job)) await forget(id, job)
      for (const raw of acknowledged) {
        const accepted = Object.freeze(T3LaneInspectionAcceptedSchema.parse(raw))
        const job = jobs.get(accepted.inspectionId)
        if (!job || job.abort.signal.aborted) throw new Error('T3_INVALID_INSPECTION_ACK')
        if (job.accepted) {
          if (canonicalExecutorJson(accepted) !== canonicalExecutorJson(job.accepted)) {
            throw new Error('T3_INSPECTION_REPLAY_CONFLICT')
          }
          continue // Exact duplicate cannot refresh the timer or repeat lifecycle work.
        }
        if (!job.receipt || !sent.includes(job.receipt) || !runtime.acceptInspection) {
          throw new Error('T3_INVALID_INSPECTION_ACK')
        }
        const challenge = job.challenge
        const expiry = Date.parse(accepted.expiresAt)
        if (accepted.executorId !== executorId || accepted.connectionEpoch !== epoch
          || accepted.environmentId !== challenge.environmentId
          || accepted.runtimeGeneration !== challenge.runtimeGeneration
          || accepted.sourceRevision !== challenge.sourceRevision
          || accepted.physicalRootKey !== challenge.sourceRootKey
          || accepted.captureGeneration !== challenge.sourceGeneration
          || accepted.correlationId !== challenge.correlationId
          || accepted.commandId !== challenge.commandId || accepted.requestSha256 !== challenge.requestSha256
          || accepted.relayHmac !== challenge.relayHmac || accepted.receiptDigest !== digest(job.receipt.receipt)
          || !Number.isFinite(expiry) || expiry > job.expiresAt) throw new Error('T3_INVALID_INSPECTION_ACK')
        if (expiry <= Date.now()) { await forget(accepted.inspectionId, job); continue }
        job.expiresAt = expiry
        job.accepted = accepted
        arm(accepted.inspectionId, job)
        job.accepting = Promise.resolve().then(() => runtime.acceptInspection!(job.request, accepted, job.abort.signal))
        try { await job.accepting } catch (error) { await forget(accepted.inspectionId, job); throw error }
        job.receipt = undefined // Drop only receipt work. The graph parent signal remains live.
      }
      if (generation !== lifecycle) return
      for (const offer of offers) {
        if (!runtime.inspect || !runtime.acceptInspection || !runtime.releaseInspection) {
          throw new Error('T3_EXECUTION_INSPECTION_UNBOUND')
        }
        if (Buffer.byteLength(JSON.stringify(offer)) > T3_LANE_LIMITS.requestBytes + 65_536) {
          throw new Error('T3_LANE_CAPACITY')
        }
        const signed = T3ExecutionSignedAdmissionSchema.parse(offer.inspection)
        const inspection = T3ExecutionInspectionSchema.parse(JSON.parse(signed.payload))
        const request = decodeExecutorT3LaneOperation(offer.request)
        const requestSha256 = 'sha256:' + createHash('sha256')
          .update(JSON.stringify(encodeExecutorT3LaneOperation(request)), 'utf8').digest('hex')
        const expiry = Date.parse(offer.retentionExpiresAt)
        if (!isT3NativeLaunchOperation(request) || request.kind !== 'request'
          || inspection.inspectionId !== offer.inspectionId || inspection.relayHmac !== offer.relayHmac
          || request.executorId !== executorId || request.connectionEpoch !== epoch
          || inspection.executorId !== executorId || inspection.connectionEpoch !== epoch
          || inspection.environmentId !== request.environmentId
          || inspection.runtimeGeneration !== request.runtimeGeneration
          || inspection.correlationId !== request.correlationId || inspection.commandId !== request.commandId
          || inspection.sourceRevision !== request.sourceRevision || inspection.requestSha256 !== requestSha256
          || !Number.isFinite(expiry) || expiry < inspection.expiresAtMs
          || !runtimes.some(row => row.role === 'source-inspection' && row.environmentId === request.environmentId
            && row.runtimeGeneration === request.runtimeGeneration && row.sourceRevision === request.sourceRevision
            && row.physicalRootKey === inspection.sourceRootKey
            && row.captureGeneration === inspection.sourceGeneration)) {
          throw new Error('T3_LANE_CORRELATION')
        }
        const wire = canonicalExecutorJson(offer)
        const old = jobs.get(offer.inspectionId)
        if (old) {
          if (old.wire !== wire) throw new Error('T3_INSPECTION_REPLAY_CONFLICT')
          continue
        }
        if (inspection.expiresAtMs <= Date.now() || expiry <= Date.now()) continue
        if (jobs.size >= remaining) throw new Error('T3_LANE_CAPACITY')
        const abort = new AbortController()
        const job: Job = { wire, request, challenge: inspection, abort, expiresAt: expiry, done: Promise.resolve() }
        jobs.set(offer.inspectionId, job)
        arm(offer.inspectionId, job)
        job.done = Promise.resolve().then(async () => {
          const receipt = T3ExecutionReceiptSchema.parse(await runtime.inspect!(request, abort.signal,
            { inspection: signed, relayHmac: offer.relayHmac, retentionExpiresAt: offer.retentionExpiresAt }))
          if (receipt.domain !== T3_EXECUTION_GRAPH_DOMAIN) throw new Error('T3_EXECUTION_GRAPH_REQUIRED')
          if (!abort.signal.aborted && job.expiresAt > Date.now()) {
            job.receipt = { inspectionId: offer.inspectionId, receipt }
          }
        }).catch(() => { abort.abort() })
        void job.done.then(() => { if (abort.signal.aborted) void forget(offer.inspectionId, job) })
      }
    },
  }
}
