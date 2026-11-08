import { RetainedImportLeaseSchema } from '@nessie/executor-protocol'
import { decodeT3LaneProvenance, T3_LANE_LIMITS, T3ExecutionReceiptSchema, T3ExecutionGraphPayloadSchema,
  T3_EXECUTION_GRAPH_DOMAIN, isT3NativeLaunchOperation, encodeExecutorT3LaneOperation,
  type ExecutorT3LaneDelivery, type ExecutorT3LaneOperation } from '@nessie/executor-protocol/t3-session'
import { retainedImportOperationBinding } from './t3-session/ownership/import-operation.js'
import { createHash } from 'node:crypto'

/** Freeze the decoded copy, never the response object's caller-owned data. */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Correlation and transport bounds only. Runtime must consume the matching
 * actual local native grant; decoding this descriptor does not grant access.
 */
export function snapshotT3LaneDelivery(raw: ExecutorT3LaneDelivery,
  request: ExecutorT3LaneOperation, now = Date.now()): ExecutorT3LaneDelivery {
  if (!/^hmac-sha256:[a-f0-9]{64}$/u.test(raw.requestDigest)) throw new Error('T3_LANE_CORRELATION')
  if (Buffer.byteLength(JSON.stringify(raw)) > T3_LANE_LIMITS.controlBytes) throw new Error('T3_LANE_CAPACITY')
  const catalogLeases = raw.catalogLeases === undefined ? undefined
    : RetainedImportLeaseSchema.array().min(1).max(T3_LANE_LIMITS.active).parse(raw.catalogLeases)
  if (catalogLeases) {
    if (new Set(catalogLeases.map(lease => lease.leaseId)).size !== catalogLeases.length) {
      throw new Error('T3_LANE_CORRELATION')
    }
    for (const lease of catalogLeases) {
      retainedImportOperationBinding(lease, request, raw.requestDigest)
      const expiry = Date.parse(lease.expiresAt)
      if (expiry <= now || expiry > now + T3_LANE_LIMITS.leaseMs) throw new Error('T3_LANE_AUTHORITY_EXPIRED')
    }
  }
  const executionGraph = raw.executionGraph === undefined ? undefined : T3ExecutionReceiptSchema.parse(raw.executionGraph)
  if (executionGraph) {
    const graph = T3ExecutionGraphPayloadSchema.parse(JSON.parse(executionGraph.payload))
    const binding = graph.binding
    const digest = 'sha256:' + createHash('sha256')
      .update(JSON.stringify(encodeExecutorT3LaneOperation(request)), 'utf8').digest('hex')
    if (catalogLeases || !isT3NativeLaunchOperation(request) || request.kind !== 'request'
      || executionGraph.domain !== T3_EXECUTION_GRAPH_DOMAIN || binding.relayHmac !== raw.requestDigest
      || binding.requestSha256 !== digest || binding.executorId !== request.executorId
      || binding.environmentId !== request.environmentId || binding.connectionEpoch !== request.connectionEpoch
      || binding.runtimeGeneration !== request.runtimeGeneration || binding.correlationId !== request.correlationId
      || binding.commandId !== request.commandId || graph.sourceRevision !== request.sourceRevision) {
      throw new Error('T3_LANE_CORRELATION')
    }
    // Receipt freshness applies when the backend accepts graph evidence. The
    // later offer is bounded by its separately consumed parent admission and
    // fixed relay expiry, never by re-signing or extending the original receipt.
  }
  if (isT3NativeLaunchOperation(request) && !executionGraph) throw new Error('T3_EXECUTION_GRAPH_REQUIRED')
  return freeze({ requestDigest: raw.requestDigest,
    ...(raw.provenance === undefined ? {} : { provenance: decodeT3LaneProvenance(raw.provenance) }),
    ...(catalogLeases === undefined ? {} : { catalogLeases }),
    ...(executionGraph === undefined ? {} : { executionGraph }) })
}

/** Credits cannot extend a descriptor. A new operation needs fresh admission. */
export const t3LaneDeliveryExpiry = (delivery: ExecutorT3LaneDelivery, expiresAt: number): number =>
  Math.min(expiresAt, ...delivery.catalogLeases?.map(lease => Date.parse(lease.expiresAt)) ?? [])
