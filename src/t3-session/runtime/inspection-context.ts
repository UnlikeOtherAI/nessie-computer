import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type * as Scope from 'effect/Scope'
import type * as SqlClient from 'effect/sql/SqlClient'
import { makeSessionEngineGraphWithAdapters, Settings, CommandLineage, EffectClaims, Outbox }
  from '@nessie/t3-session-source/engine'
import type { ServerSettingsError } from '@nessie/t3-session-source/contracts'
import type { OwnedCaptureSqlError } from '../import/materialize.js'
import type { ExecutorT3Request, ExecutorT3LaneDelivery, T3ExecutionSignedAdmission }
  from '@nessie/executor-protocol/t3-session'
import { T3ExecutionInspectionSchema, T3ExecutionGraphPayloadSchema } from '@nessie/executor-protocol/t3-session'
import type { T3ExecutionProcessLossObservation } from '@nessie/executor-protocol'
import type { T3ExecutionResourceScope } from '../source/execution.js'
import type { HeldSessionExecutionState } from './execution-state.js'
import { sessionExecutionSettingsLayer } from './execution-settings.js'
import { SessionStateOwner } from './state-owner.js'
import { prepareSessionExecutionGraph, recognizeSessionExecutionGraph, SessionExecutionGraphRefused,
  type HeldSessionExecutionGraph, type SessionExecutionGraphPreparation, type SessionExecutionGraphRecognition }
  from './execution-graph.js'
import type { EffectValue, EffectFailure, EffectServices, ContextServices } from './effect-types.js'
import { makeSessionCommandLineageRegistry, type SessionCommandLineageRegistry } from './command-lineage-registry.js'
import { joinedNativeEffect } from './native-effect.js'

type LaunchRequest = Extract<ExecutorT3Request, { readonly method: 'orchestration.launchThread' }>
type EngineOwner = EffectValue<typeof makeSessionEngineGraphWithAdapters>
type Inspection = EngineOwner['inspection']
type HostServices = SqlClient.SqlClient | Settings.ServerSettingsReadService | SessionStateOwner
  | CommandLineage.SessionCommandLineage | EffectClaims.SessionEffectClaimAuthority
type ColdServices = HostServices | ContextServices<EffectValue<Inspection>>
export type SessionProcessLossInspection = Effect.Effect<{
  readonly candidate: Outbox.OrchestrationProcessLossCandidate
  readonly observation: Readonly<T3ExecutionProcessLossObservation>
}, EffectFailure<SessionExecutionGraphRecognition> | Outbox.EffectOutboxError | SessionExecutionGraphRefused,
Scope.Scope>
export interface SessionInspectionContext {
  readonly engine: EngineOwner
  readonly commandLineage: SessionCommandLineageRegistry
  readonly withCommandLineageCapture: T3ExecutionResourceScope['withOriginalCommandLineage']
  readonly executionSource: T3ExecutionResourceScope
  readonly context: Context.Context<ColdServices>
  readonly recheck: Effect.Effect<void, SessionExecutionGraphRefused>
  inspect(request: LaunchRequest,
    delivery: { readonly inspection: T3ExecutionSignedAdmission; readonly relayHmac: string }):
    Effect.Effect<HeldSessionExecutionGraph, EffectFailure<SessionExecutionGraphPreparation>, Scope.Scope>
  recognize(graph: HeldSessionExecutionGraph, request: LaunchRequest, delivery: ExecutorT3LaneDelivery):
    Effect.Effect<EffectValue<SessionExecutionGraphRecognition>, EffectFailure<SessionExecutionGraphRecognition>>
  /** Matching current inputs only. This supplies no lifecycle action owner. */
  observeProcessLoss(graph: HeldSessionExecutionGraph, request: LaunchRequest,
    delivery: ExecutorT3LaneDelivery): SessionProcessLossInspection
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
    const commandLineage = makeSessionCommandLineageRegistry(AbortSignal.any([source.signal, state.signal]))
    yield* Effect.addFinalizer(() => Effect.promise(commandLineage.close))
    const host = yield* Layer.build(Layer.mergeAll(state.stage.sql,
      sessionExecutionSettingsLayer(source), Layer.succeed(SessionStateOwner, state.owner),
      Layer.succeed(CommandLineage.SessionCommandLineage, commandLineage.service),
      Layer.succeed(EffectClaims.SessionEffectClaimAuthority, commandLineage.effectClaims)))
    const engine = yield* makeSessionEngineGraphWithAdapters
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
    const observeProcessLoss = (graph: HeldSessionExecutionGraph, request: LaunchRequest,
      delivery: ExecutorT3LaneDelivery): SessionProcessLossInspection => Effect.gen(function* () {
      yield* recognize(graph, request, delivery)
      const outbox = yield* Outbox.EffectOutboxV2.pipe(Effect.provide(context))
      // This is the original outbox already built over state.stage.sql in the
      // cold graph's existing memo map. No original engine, source connection
      // or destination writer is rebuilt for the independent native read.
      const candidate = yield* outbox.prepareProcessLoss
      const observed = yield* joinedNativeEffect(async cancellation => {
        const signal = AbortSignal.any([cancellation, source.signal, state.signal])
        signal.throwIfAborted()
        const payload = T3ExecutionGraphPayloadSchema.parse(JSON.parse(graph.receipt.payload))
        const facts = await source.inspectProcessLoss(payload)
        signal.throwIfAborted()
        return facts
      }, () => new SessionExecutionGraphRefused())
      yield* recognize(graph, request, delivery)
      return yield* Effect.try({ try: () => {
        const effects = candidate.effects, cancelled = effects.filter(e => e.transition === 'cancel').length
        const now = Date.now()
        if (observed.planDigest !== candidate.planDigest || observed.rowCount !== effects.length
          || observed.cancelled !== cancelled || observed.requeued !== effects.length - cancelled
          || observed.observedAtMs < candidate.observedAtMs || now < observed.observedAtMs
          || now >= candidate.observedAtMs + 5000 || now >= observed.observedAtMs + 5000) {
          throw new SessionExecutionGraphRefused()
        }
        return Object.freeze({ candidate, observation: Object.freeze({ ...observed }) })
      }, catch: () => new SessionExecutionGraphRefused() })
    })
    return { engine, commandLineage, withCommandLineageCapture: source.withOriginalCommandLineage,
      executionSource: source,
      context, inspect, recognize, observeProcessLoss, recheck: current }
  })
