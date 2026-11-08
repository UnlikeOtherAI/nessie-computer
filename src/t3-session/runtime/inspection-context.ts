import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type * as Scope from 'effect/Scope'
import type * as SqlClient from 'effect/sql/SqlClient'
import { makeSessionEngineGraph, Settings } from '@nessie/t3-session-source/engine'
import type { ServerSettingsError } from '@nessie/t3-session-source/contracts'
import type { OwnedCaptureSqlError } from '../import/materialize.js'
import type { ExecutorT3Request, ExecutorT3LaneDelivery, T3ExecutionSignedAdmission }
  from '@nessie/executor-protocol/t3-session'
import { T3ExecutionInspectionSchema } from '@nessie/executor-protocol/t3-session'
import type { T3ExecutionResourceScope } from '../source/execution.js'
import type { HeldSessionExecutionState } from './execution-state.js'
import { sessionExecutionSettingsLayer } from './execution-settings.js'
import { SessionStateOwner } from './state-owner.js'
import { prepareSessionExecutionGraph, recognizeSessionExecutionGraph, SessionExecutionGraphRefused,
  type HeldSessionExecutionGraph, type SessionExecutionGraphPreparation, type SessionExecutionGraphRecognition }
  from './execution-graph.js'
import type { EffectValue, EffectFailure, EffectServices, ContextServices } from './effect-types.js'

type LaunchRequest = Extract<ExecutorT3Request, { readonly method: 'orchestration.launchThread' }>
type EngineOwner = EffectValue<typeof makeSessionEngineGraph>
type Inspection = EngineOwner['inspection']
type HostServices = SqlClient.SqlClient | Settings.ServerSettingsReadService | SessionStateOwner
type ColdServices = HostServices | ContextServices<EffectValue<Inspection>>
export interface SessionInspectionContext {
  readonly engine: EngineOwner
  readonly context: Context.Context<ColdServices>
  inspect(request: LaunchRequest,
    delivery: { readonly inspection: T3ExecutionSignedAdmission; readonly relayHmac: string }):
    Effect.Effect<HeldSessionExecutionGraph, EffectFailure<SessionExecutionGraphPreparation>, Scope.Scope>
  recognize(graph: HeldSessionExecutionGraph, request: LaunchRequest, delivery: ExecutorT3LaneDelivery):
    Effect.Effect<EffectValue<SessionExecutionGraphRecognition>, EffectFailure<SessionExecutionGraphRecognition>>
}
export type SessionInspectionContextEffect = Effect.Effect<SessionInspectionContext,
  OwnedCaptureSqlError | ServerSettingsError | EffectFailure<Inspection> | SessionExecutionGraphRefused,
  Exclude<EffectServices<Inspection>, HostServices> | Scope.Scope>

/** Build the original cold graph over the already-open destination SQL handle.
 * The owner Scope is retained by the fixed runtime through inspection and
 * actual admission. Its returned engine is the SAME memo/scope owner used for
 * subsequent activation; this function does not construct higher services.
 * No settings value or mutable Context is serialized onto the daemon pipe. */
export const makeSessionInspectionContext = (source: T3ExecutionResourceScope,
  state: HeldSessionExecutionState): SessionInspectionContextEffect =>
  Effect.gen(function* () {
    const current = Effect.tryPromise({ try: () => state.recheck(), catch: () => new SessionExecutionGraphRefused() })
    yield* current
    const host = yield* Layer.build(Layer.mergeAll(state.stage.sql,
      sessionExecutionSettingsLayer(source), Layer.succeed(SessionStateOwner, state.owner)))
    const engine = yield* makeSessionEngineGraph
    const cold = yield* engine.inspection.pipe(Effect.provide(host))
    const context = Context.merge(host, cold)
    yield* current
    // Each inspection has its own caller-held Scope. Its opaque graph/selection
    // must remain held until accepted original command dispatch has finished;
    // wrapping inspect in a short-lived Effect.scoped would destroy that record.
    const inspect = (request: LaunchRequest,
      delivery: { readonly inspection: T3ExecutionSignedAdmission; readonly relayHmac: string }) =>
      Effect.gen(function* () {
        yield* current
        const challenge = yield* Effect.try({
          try: () => T3ExecutionInspectionSchema.parse(JSON.parse(delivery.inspection.payload)),
          catch: () => new SessionExecutionGraphRefused(),
        })
        if (challenge.sourceGeneration !== state.captureGeneration
          || challenge.sourceRootKey !== state.source.physicalRootKey
          || challenge.runtimeGeneration !== state.owner.runtimeGeneration) {
          return yield* Effect.fail(new SessionExecutionGraphRefused())
        }
        const graph = yield* prepareSessionExecutionGraph(request, delivery, source).pipe(Effect.provide(context))
        yield* current
        return graph
      })
    const recognize = (graph: HeldSessionExecutionGraph, request: LaunchRequest, delivery: ExecutorT3LaneDelivery) =>
      Effect.gen(function* () {
        yield* current
        const target = yield* recognizeSessionExecutionGraph(graph, request, delivery).pipe(Effect.provide(context))
        yield* current
        return target
      })
    return { engine, context, inspect, recognize }
  })
