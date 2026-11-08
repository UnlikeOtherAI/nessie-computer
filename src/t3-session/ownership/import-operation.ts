import { createHash } from 'node:crypto'
import * as Schema from 'effect/Schema'
import { RetainedImportLeaseSchema, type RetainedImportLease,
  type RetainedImportOperationBinding } from '@nessie/executor-protocol'
import { ExecutorT3HttpRequest, encodeExecutorT3Request, type ExecutorT3LaneOperation } from '@nessie/executor-protocol/t3-session'
import { requireCapture } from '../state/sqlite.js'

/** Check the complete decoded request, not just its routed thread. Call using
 * the actual lane offer before passing the result to local.authority. Native
 * consent and backend recheck still establish authority; this is correlation.
 */
export function retainedImportOperationBinding(raw: RetainedImportLease,
  request: ExecutorT3LaneOperation, relayRequestDigest: string): RetainedImportOperationBinding {
  const lease = RetainedImportLeaseSchema.parse(raw)
  const encoded = request.kind === 'request' ? encodeExecutorT3Request(request)
    : Schema.encodeSync(Schema.toCodecJson(ExecutorT3HttpRequest))(request)
  const digest = createHash('sha256').update(JSON.stringify(encoded)).digest('hex')
  const binding = lease.operationBinding
  requireCapture(lease.purpose === 'catalog' && binding !== undefined
    && binding.requestDigest === digest && binding.relayRequestDigest === relayRequestDigest
    && binding.correlationId === request.correlationId && lease.executorId === request.executorId
    && lease.environmentId === request.environmentId, 'retained_import_operation_substitution')
  return binding!
}
