import * as Effect from 'effect/Effect'
import * as Cause from 'effect/Cause'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { isStreamSchema } from 'effect/rpc/RpcSchema'
import { EnvironmentAuthenticatedAuth } from '@nessie/t3-session-source/contracts'
import { ExecutorT3Descriptors, ExecutorT3HttpEndpoints, ExecutorT3LaneOperation, ExecutorT3LaneReply,
  type ExecutorT3ImplementationSlots, ExecutorT3Request, ExecutorT3HttpRequest,
} from '@nessie/executor-protocol/t3-session'
import type { RetainedCatalogService } from '../catalog/service.js'

type Outcome = { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'error'; readonly error: unknown }
const succeeded = (value: unknown): Outcome => ({ kind: 'value', value })
const failed = (error: unknown): Outcome => ({ kind: 'error', error })
const checkedReply = (value: unknown): ExecutorT3LaneReply => {
  // Slot values are already decoded. Do not decode them a second time: original
  // DateTime, compact-ID and error-class codecs may have distinct wire shapes.
  if (!Schema.is(ExecutorT3LaneReply)(value)) throw new Error('T3_RUNTIME_REPLY_INVALID')
  return value
}

const runWithSignal = async <A, E>(operation: Effect.Effect<A, E>, signal: AbortSignal): Promise<A> => {
  const exit = await Effect.runPromiseExit(operation, { signal })
  if (Exit.isSuccess(exit)) return exit.value
  // Only pure interruption is cancellation. A failing finalizer must survive
  // even when cancellation happened concurrently, so shutdown cannot claim it.
  if (signal.aborted && Cause.hasInterruptsOnly(exit.cause)) throw signal.reason
  return Effect.runPromise(Effect.failCause(exit.cause))
}

/** Copy only routing fields. Never spread a request payload into a response. */
const routing = (request: ExecutorT3LaneOperation, relayOrdinal: number) => ({
  transportVersion: request.transportVersion, protocolVersion: request.protocolVersion,
  sourceRevision: request.sourceRevision, executorId: request.executorId, environmentId: request.environmentId,
  connectionEpoch: request.connectionEpoch, runtimeGeneration: request.runtimeGeneration,
  correlationId: request.correlationId, relayOrdinal,
  ...(request.sourceThreadId === undefined ? {} : { sourceThreadId: request.sourceThreadId }),
})

const untilAbort = (signal: AbortSignal) => Effect.callback<void>(resume => {
  const aborted = () => resume(Effect.void)
  if (signal.aborted) { aborted(); return }
  signal.addEventListener('abort', aborted, { once: true })
  return Effect.sync(() => signal.removeEventListener('abort', aborted))
})

const rpcReply = (request: ExecutorT3Request, outcome: Outcome, ordinal: number) => checkedReply({
  ...routing(request, ordinal), method: request.method,
  ...(outcome.kind === 'error' ? { kind: 'error', error: outcome.error }
    : { kind: isStreamSchema(ExecutorT3Descriptors[request.method].successSchema) ? 'stream' : 'result',
      result: outcome.value }),
})

/**
 * Internal codec/iterator adapter over ALREADY admitted, scoped slots. This
 * constructs no graph, grants no access and registers no transport. The lane
 * owner must check its held source/epoch/generation and admit each operation
 * before calling it. Unbound methods remain explicit transport failures.
 */
export async function* dispatchSessionRpc(request: ExecutorT3Request,
  slots: ExecutorT3ImplementationSlots, signal: AbortSignal): AsyncIterable<ExecutorT3LaneReply> {
  signal.throwIfAborted()
  if (!Schema.is(ExecutorT3Request)(request)) throw new Error('T3_RUNTIME_REQUEST_INVALID')
  const handler = slots[request.method]
  if (!handler) {
    yield checkedReply({ ...routing(request, 0), kind: 'transport-error', code: 'unbound_operation' })
    return
  }
  // The original request union correlates this method with its decoded input.
  // Erase that relation only at dynamic invocation; every result is checked by
  // the original union again. No public input/result contract is widened.
  const invoke = handler as (input: never) => Effect.Effect<unknown, unknown> | Stream.Stream<unknown, unknown>
  const operation = invoke(request.input as never)
  const streaming = isStreamSchema(ExecutorT3Descriptors[request.method].successSchema)
  if (!streaming) {
    if (!Effect.isEffect(operation)) throw new Error('T3_RUNTIME_OPERATION_KIND_MISMATCH')
    const outcome = await runWithSignal(operation.pipe(Effect.match({
      onSuccess: succeeded, onFailure: failed,
    })), signal)
    signal.throwIfAborted()
    yield rpcReply(request, outcome, 0)
    return
  }
  if (!Stream.isStream(operation)) throw new Error('T3_RUNTIME_OPERATION_KIND_MISMATCH')
  const outcomes = operation.pipe(Stream.map(succeeded), Stream.catch(error => Stream.succeed(failed(error))),
    Stream.interruptWhen(untilAbort(signal)))
  let ordinal = 0
  // Demand is pulled directly. No collect, snapshot polling or replay queue.
  for await (const outcome of Stream.toAsyncIterable(outcomes)) {
    signal.throwIfAborted()
    yield rpcReply(request, outcome, ordinal++)
  }
  signal.throwIfAborted()
}

const httpStatus = (request: ExecutorT3HttpRequest, outcome: Outcome): number => {
  const endpoint = ExecutorT3HttpEndpoints[request.endpoint]
  const candidates = outcome.kind === 'value' ? [...endpoint.success]
    : [...endpoint.error, ...EnvironmentAuthenticatedAuth.error]
  const value = outcome.kind === 'value' ? outcome.value : outcome.error
  const matching = candidates.filter(codec => Schema.is(codec)(value))
  const statuses = new Set(matching.map(codec => codec.ast.annotations?.httpApiStatus
    ?? (outcome.kind === 'value' ? 200 : undefined)))
  const status = [...statuses][0]
  if (statuses.size !== 1 || typeof status !== 'number') throw new Error('T3_RUNTIME_HTTP_STATUS_UNBOUND')
  return status
}

/** Same five original HTTP endpoints; no Nessie JSON wrapper or status guessing. */
export async function* dispatchRetainedHttp(request: ExecutorT3HttpRequest,
  http: RetainedCatalogService['http'], signal: AbortSignal): AsyncIterable<ExecutorT3LaneReply> {
  signal.throwIfAborted()
  if (!Schema.is(ExecutorT3HttpRequest)(request)) throw new Error('T3_RUNTIME_REQUEST_INVALID')
  const handler = http[request.endpoint]
  // Endpoint correlation is established by the original request codec above.
  const invoke = handler as (input: never) => Effect.Effect<{ value: unknown; sourceSequence: number }, unknown>
  const operation = invoke({
    ...('params' in request ? { params: request.params } : {}),
    ...('query' in request ? { query: request.query } : {}),
  } as never)
  const outcome = await runWithSignal(operation.pipe(Effect.match({
    onSuccess: result => ({ kind: 'value' as const, value: result.value, sourceSequence: result.sourceSequence }),
    onFailure: failed,
  })), signal)
  signal.throwIfAborted()
  yield checkedReply({ ...routing(request, 0), endpoint: request.endpoint,
    status: httpStatus(request, outcome), headers: {},
    ...(outcome.kind === 'value' ? { kind: 'http-result', body: outcome.value,
      ...('sourceSequence' in outcome ? { sourceSequence: outcome.sourceSequence } : {}) }
      : { kind: 'http-error', body: outcome.error }),
  })
}
