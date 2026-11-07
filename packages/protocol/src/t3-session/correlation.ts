import * as Schema from 'effect/Schema'
import { ExecutorT3Request } from './request.js'
import type { ExecutorT3Result, ExecutorT3Error } from './reply.js'
import { ExecutorT3TransportError } from './routing.js'

export const encodeExecutorT3Request = Schema.encodeSync(Schema.toCodecJson(ExecutorT3Request))
export const decodeExecutorT3Request = Schema.decodeUnknownSync(Schema.toCodecJson(ExecutorT3Request), {
  onExcessProperty: 'error',
})

/** A successful codec check does not make a frame a reply to this request. */
export const requireExecutorT3Correlation = (
  request: ExecutorT3Request,
  reply: ExecutorT3Result | ExecutorT3Error | typeof ExecutorT3TransportError.Type,
): void => {
  if (request.executorId !== reply.executorId || request.environmentId !== reply.environmentId
    || request.connectionEpoch !== reply.connectionEpoch || request.runtimeGeneration !== reply.runtimeGeneration
    || request.correlationId !== reply.correlationId || request.sourceRevision !== reply.sourceRevision
    || 'method' in reply && request.method !== reply.method) throw new Error('T3_REPLY_CORRELATION_MISMATCH')
  // relayOrdinal belongs to each transport frame. sourceSequence belongs to the
  // engine log. Neither is a request identity or an equality requirement here.
}
