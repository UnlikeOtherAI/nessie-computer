import { createHash } from 'node:crypto'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3ExecutionInspectionSchema, T3ExecutionReceiptSchema, T3_EXECUTION_GRAPH_DOMAIN,
  T3ExecutionSignedAdmissionSchema, decodeExecutorT3LaneOperation, encodeExecutorT3LaneOperation,
  isT3NativeLaunchOperation, T3_LANE_LIMITS,
  type T3LaneInspection, type T3LaneInspectionReceipt, type T3RuntimeAnnouncement,
} from '@nessie/executor-protocol/t3-session'
import type { T3SessionLaneRuntime } from './t3-session-lane.js'

type Job = { wire: string; abort: AbortController; done: Promise<void>; expiresAt: number;
  receipt?: T3LaneInspectionReceipt; timer: ReturnType<typeof setTimeout> }

/** Bounded nonexecuting work on the existing daemon exchange. Receipt retries
 * retain exact bytes. Native verification and held source ownership remain in
 * runtime.inspect; a decoded backend envelope never authorizes engine effects.
 */
export function createT3InspectionPump(runtime: T3SessionLaneRuntime) {
  const jobs = new Map<string, Job>()
  const forget = (id: string, job: Job) => {
    clearTimeout(job.timer)
    job.abort.abort()
    // Keep the slot until the actual graph/source finalizers have joined.
    void job.done.finally(() => { if (jobs.get(id) === job) jobs.delete(id) })
  }
  return {
    size: () => jobs.size,
    frames(): T3LaneInspectionReceipt[] {
      return [...jobs.values()].flatMap(job => job.receipt && job.expiresAt > Date.now() ? [job.receipt] : [])
        .slice(0, T3_LANE_LIMITS.exchangeFrames)
    },
    async close() {
      const current = [...jobs.entries()]
      for (const [id, job] of current) forget(id, job)
      await Promise.all(current.map(([, job]) => job.done))
    },
    accept(executorId: string, epoch: string, runtimes: readonly T3RuntimeAnnouncement[],
      offers: readonly T3LaneInspection[], acknowledged: readonly string[],
      sent: readonly T3LaneInspectionReceipt[], remaining: number) {
      if (offers.length > T3_LANE_LIMITS.exchangeFrames || acknowledged.length > T3_LANE_LIMITS.exchangeFrames) {
        throw new Error('T3_LANE_CAPACITY')
      }
      for (const id of acknowledged) {
        const job = jobs.get(id)
        if (!job?.receipt || !sent.includes(job.receipt)) throw new Error('T3_INVALID_INSPECTION_ACK')
        forget(id, job)
      }
      for (const offer of offers) {
        if (!runtime.inspect) throw new Error('T3_EXECUTION_INSPECTION_UNBOUND')
        if (Buffer.byteLength(JSON.stringify(offer)) > T3_LANE_LIMITS.requestBytes + 65_536) {
          throw new Error('T3_LANE_CAPACITY')
        }
        const signed = T3ExecutionSignedAdmissionSchema.parse(offer.inspection)
        const inspection = T3ExecutionInspectionSchema.parse(JSON.parse(signed.payload))
        const request = decodeExecutorT3LaneOperation(offer.request)
        const digest = 'sha256:' + createHash('sha256')
          .update(JSON.stringify(encodeExecutorT3LaneOperation(request)), 'utf8').digest('hex')
        if (!isT3NativeLaunchOperation(request) || request.kind !== 'request'
          || inspection.inspectionId !== offer.inspectionId || inspection.relayHmac !== offer.relayHmac
          || request.executorId !== executorId || request.connectionEpoch !== epoch
          || inspection.executorId !== executorId || inspection.connectionEpoch !== epoch
          || inspection.environmentId !== request.environmentId
          || inspection.runtimeGeneration !== request.runtimeGeneration
          || inspection.correlationId !== request.correlationId || inspection.commandId !== request.commandId
          || inspection.sourceRevision !== request.sourceRevision || inspection.requestSha256 !== digest
          || !runtimes.some(row => row.state === 'ready' && row.environmentId === request.environmentId
            && row.runtimeGeneration === request.runtimeGeneration)) throw new Error('T3_LANE_CORRELATION')
        const wire = canonicalExecutorJson(offer)
        const old = jobs.get(offer.inspectionId)
        if (old) {
          if (old.wire !== wire) throw new Error('T3_INSPECTION_REPLAY_CONFLICT')
          continue
        }
        if (inspection.expiresAtMs <= Date.now()) continue
        if (jobs.size >= remaining) throw new Error('T3_LANE_CAPACITY')
        const abort = new AbortController()
        const job: Job = { wire, abort, expiresAt: inspection.expiresAtMs, done: Promise.resolve(),
          timer: setTimeout(() => { forget(offer.inspectionId, job) }, inspection.expiresAtMs - Date.now()) }
        job.timer.unref()
        jobs.set(offer.inspectionId, job)
        job.done = Promise.resolve().then(async () => {
          const receipt = T3ExecutionReceiptSchema.parse(await runtime.inspect!(request, abort.signal,
            { inspection: signed, relayHmac: offer.relayHmac }))
          if (receipt.domain !== T3_EXECUTION_GRAPH_DOMAIN) throw new Error('T3_EXECUTION_GRAPH_REQUIRED')
          if (!abort.signal.aborted && job.expiresAt > Date.now()) {
            job.receipt = { inspectionId: offer.inspectionId, receipt }
          }
        }).catch(() => { abort.abort() })
      }
    },
  }
}
