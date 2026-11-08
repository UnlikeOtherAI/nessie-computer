import * as Schema from 'effect/Schema'
import { isStreamSchema } from 'effect/rpc/RpcSchema'
import { ExecutorT3Request } from './request.js'
import { ExecutorT3Result, ExecutorT3Error } from './reply.js'
import { ExecutorT3HttpRequest, ExecutorT3HttpReply, ExecutorT3HttpFailure } from './http-transport.js'
import { ExecutorT3TransportError } from './routing.js'
import { ExecutorT3Descriptors } from './methods.js'

/** One daemon lane carries the original envelopes, without native conversation DTOs. */
export const ExecutorT3LaneOperation = Schema.Union([ExecutorT3Request, ExecutorT3HttpRequest])
export type ExecutorT3LaneOperation = typeof ExecutorT3LaneOperation.Type
export type ExecutorT3LaneOperationEncoded = ReturnType<typeof encodeExecutorT3LaneOperation>
export const ExecutorT3LaneReply = Schema.Union([
  ExecutorT3Result, ExecutorT3Error, ExecutorT3HttpReply, ExecutorT3HttpFailure, ExecutorT3TransportError,
])
export type ExecutorT3LaneReply = typeof ExecutorT3LaneReply.Type
export type ExecutorT3LaneReplyEncoded = ReturnType<typeof encodeExecutorT3LaneReply>
export const encodeExecutorT3LaneOperation = Schema.encodeSync(Schema.toCodecJson(ExecutorT3LaneOperation))
export const decodeExecutorT3LaneOperation = Schema.decodeUnknownSync(Schema.toCodecJson(ExecutorT3LaneOperation), {
  onExcessProperty: 'error',
})
export const encodeExecutorT3LaneReply = Schema.encodeSync(Schema.toCodecJson(ExecutorT3LaneReply))
export const decodeExecutorT3LaneReply = Schema.decodeUnknownSync(Schema.toCodecJson(ExecutorT3LaneReply), {
  onExcessProperty: 'error',
})
export const isExecutorT3Stream = (request: ExecutorT3LaneOperation): boolean =>
  request.kind === 'request' && isStreamSchema(ExecutorT3Descriptors[request.method].successSchema)

export const T3_LANE_LIMITS = Object.freeze({
  active: 64, exchangeFrames: 8, requestBytes: 1024 * 1024,
  frameBytes: 8 * 1024 * 1024, bufferedBytes: 32 * 1024 * 1024, leaseMs: 60_000, pollMs: 250,
})

export type T3LaneFrame = {
  environmentId: string; correlationId: string; runtimeGeneration: string;
  ordinal: number; final: boolean; reply?: ExecutorT3LaneReplyEncoded;
}
export type T3LaneExchange = {
  operation: 't3.operations.exchange'; executorId: string; connectionEpoch: string;
  observedAt: string; signature: string; frames: readonly T3LaneFrame[];
  /** Exact active attempts, for cancellation and credit reconciliation. */
  active: readonly { environmentId: string; correlationId: string; runtimeGeneration: string }[];
}
export type T3LaneExchangeResult = {
  acknowledged: { environmentId: string; correlationId: string; ordinal: number }[];
  offers: { request: ExecutorT3LaneOperationEncoded; expiresAt: string }[];
  controls: { environmentId: string; correlationId: string; state: 'credit' | 'hold' | 'cancel';
    nextOrdinal: number; expiresAt?: string }[];
}
