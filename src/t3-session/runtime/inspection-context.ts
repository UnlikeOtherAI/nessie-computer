import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { makeSessionEngineGraph } from '@nessie/t3-session-source/engine'
import type { ExecutorT3Request, ExecutorT3LaneDelivery, T3ExecutionSignedAdmission }
  from '@nessie/executor-protocol/t3-session'
import type { T3ExecutionResourceScope } from '../source/execution.js'
import type { HeldSessionExecutionState } from './execution-state.js'
import { sessionExecutionSettingsLayer } from './execution-settings.js'
import { SessionStateOwner } from './state-owner.js'
import { prepareSessionExecutionGraph, recognizeSessionExecutionGraph,
  type HeldSessionExecutionGraph } from './execution-graph.js'

type LaunchRequest = Extract<ExecutorT3Request, { readonly method: 'orchestration.launchThread' }>

/** Build the original cold graph over the already-open destination SQL handle.
 * The owner Scope is retained by the fixed runtime through inspection and
 * actual admission. Its returned engine is the SAME memo/scope owner used for
 * subsequent activation; this function does not construct higher services.
 * No settings value or mutable Context is serialized onto the daemon pipe. */
export const makeSessionInspectionContext = (source: T3ExecutionResourceScope, state: HeldSessionExecutionState) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => state.recheck())
    const host = yield* Layer.build(Layer.mergeAll(state.stage.sql,
      sessionExecutionSettingsLayer(source), Layer.succeed(SessionStateOwner, state.owner)))
    const engine = yield* makeSessionEngineGraph
    const cold = yield* engine.inspection.pipe(Effect.provide(host))
    const context = Context.merge(host, cold)
    yield* Effect.tryPromise(() => state.recheck())
    // Each inspection has its own caller-held Scope. Its opaque graph/selection
    // must remain held until accepted original command dispatch has finished;
    // wrapping inspect in a short-lived Effect.scoped would destroy that record.
    const inspect = (request: LaunchRequest,
      delivery: { readonly inspection: T3ExecutionSignedAdmission; readonly relayHmac: string }) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => state.recheck())
        const graph = yield* prepareSessionExecutionGraph(request, delivery, source).pipe(Effect.provide(context))
        yield* Effect.tryPromise(() => state.recheck())
        return graph
      })
    const recognize = (graph: HeldSessionExecutionGraph, request: LaunchRequest, delivery: ExecutorT3LaneDelivery) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(() => state.recheck())
        const target = yield* recognizeSessionExecutionGraph(graph, request, delivery).pipe(Effect.provide(context))
        yield* Effect.tryPromise(() => state.recheck())
        return target
      })
    return { engine, context, inspect, recognize }
  })
