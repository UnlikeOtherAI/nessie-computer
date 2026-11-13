import * as Schema from 'effect/Schema'
import { EnvironmentId, ThreadId, TrimmedNonEmptyString, NonNegativeInt } from '@nessie/t3-session-source/contracts'

export const T3_SOURCE_COMMIT = '25bf84ab07f53f141c20239c63e383823a9d5ea0' as const
export const ExecutorT3Routing = Schema.Struct({
  transportVersion: Schema.Literal(1),
  protocolVersion: Schema.Literal(2),
  sourceRevision: Schema.Literal(T3_SOURCE_COMMIT),
  executorId: Schema.String.check(Schema.isUUID()),
  environmentId: EnvironmentId,
  // Matches the existing signed executor exchange; never coerce to a JS number.
  connectionEpoch: Schema.String.check(Schema.isPattern(/^\d+$/u)),
  runtimeGeneration: TrimmedNonEmptyString,
  correlationId: TrimmedNonEmptyString,
  relayOrdinal: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  sourceSequence: Schema.optionalKey(NonNegativeInt),
  sourceThreadId: Schema.optionalKey(ThreadId),
})
export type ExecutorT3Routing = typeof ExecutorT3Routing.Type
export type ExecutorT3RoutingEncoded = typeof ExecutorT3Routing.Encoded
export const decodeExecutorT3Routing = Schema.decodeUnknownSync(ExecutorT3Routing)

/** Broker/custody failures are separate from original source error tags. */
export const ExecutorT3TransportError = Schema.Struct({
  ...ExecutorT3Routing.fields,
  kind: Schema.Literal('transport-error'),
  code: Schema.Literals(['forbidden', 'offline', 'stale_epoch', 'stale_generation',
    'source_mismatch', 'unbound_operation', 'command_conflict', 'outcome_unknown', 'resource_expired', 'capacity_exceeded']),
})
