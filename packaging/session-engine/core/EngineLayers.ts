import * as Layer from 'effect/Layer'
import * as IdAllocator from 't3-source:packages/provider-core/src/server/IdAllocator.ts'
import * as ContinuationRequests from 't3-source:packages/provider-core/src/server/ProviderContinuationRequests.ts'
import * as ThreadCommandExecutor from 't3-source:apps/server/src/orchestration-v2/ThreadCommandExecutor.ts'
import * as Orchestrator from 't3-source:apps/server/src/orchestration-v2/Orchestrator.ts'
import * as Threads from 't3-source:apps/server/src/orchestration-v2/ThreadManagementLive.ts'
import * as Launch from 't3-source:apps/server/src/orchestration-v2/ThreadLaunchService.ts'
import * as LegacyImporter from 't3-source:apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts'
import * as Policy from 't3-source:apps/server/src/orchestration-v2/RuntimePolicy.ts'
import * as CommandPolicy from 't3-source:apps/server/src/orchestration-v2/CommandPolicy.ts'
import * as Forks from 't3-source:apps/server/src/orchestration-v2/ThreadForkService.ts'
import * as Handoffs from 't3-source:apps/server/src/orchestration-v2/ContextHandoffService.ts'
import * as Adapters from 't3-source:apps/server/src/orchestration-v2/ProviderAdapterRegistry.ts'
import * as Switches from 't3-source:apps/server/src/orchestration-v2/ProviderSwitchService.ts'
import * as Output from 't3-source:apps/server/src/orchestration-v2/CommandOutputHub.ts'
import * as Recovery from 't3-source:apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts'
import * as Continuations from 't3-source:apps/server/src/orchestration-v2/ProviderContinuationService.ts'
import * as Worker from 't3-source:apps/server/src/orchestration-v2/EffectWorker.ts'
import * as ControlLive from 't3-source:apps/server/src/orchestration-v2/ProviderTurnControlService.session-live.ts'
import * as RequestsLive from 't3-source:apps/server/src/orchestration-v2/RuntimeRequestService.session-live.ts'
import * as SessionsLive from 't3-source:apps/server/src/orchestration-v2/ProviderSessionManager.session-live.ts'
import * as ProviderEvents from 't3-source:apps/server/src/orchestration-v2/ProviderEventIngestor.ts'
import * as CheckpointCapture from 't3-source:apps/server/src/orchestration-v2/CheckpointCaptureService.ts'
import * as FinalizationLive from 't3-source:apps/server/src/orchestration-v2/RunFinalizationService.session-live.ts'
import { createSessionStateLayers } from './StateLayers.ts'

/**
 * Actual source constructors over REQUIRED host services. This is not a readiness/lifecycle API.
 * Building higher layers starts original scoped orchestration reactions. Use ReadLayers for passive reads.
 * Consumers, recovery and provider admission require the separately ordered runtime owner.
 */
export const createSessionEngineLayers = (state = createSessionStateLayers()) => {
  const shared = Layer.mergeAll(IdAllocator.layer, ContinuationRequests.layer,
    ThreadCommandExecutor.layer, CommandPolicy.layer, Forks.layer, Output.layer).pipe(Layer.provideMerge(state.layer))
  const adapters = Adapters.layerFromProviderInstanceRegistry.pipe(Layer.provide(shared))
  const providerEvents = ProviderEvents.layer.pipe(Layer.provideMerge(shared))
  const sessions = SessionsLive.layer.pipe(Layer.provideMerge(Layer.mergeAll(adapters, providerEvents)))
  const checkpointCapture = CheckpointCapture.layer.pipe(Layer.provideMerge(shared))
  const finalization = FinalizationLive.layer.pipe(Layer.provideMerge(checkpointCapture))
  const turns = Layer.mergeAll(ControlLive.layer, RequestsLive.layer).pipe(Layer.provideMerge(sessions))
  const switches = Switches.layer.pipe(Layer.provide(adapters))
  const decisions = Layer.mergeAll(Handoffs.layer, Policy.layerFromProjectStore,
    adapters, switches).pipe(Layer.provideMerge(turns))
  const legacyImporter = LegacyImporter.layer.pipe(Layer.provide(decisions))
  const orchestrator = Orchestrator.layer.pipe(Layer.provideMerge(decisions))
  const threads = Threads.layerWithLegacyImporter.pipe(
    Layer.provideMerge(Layer.mergeAll(orchestrator, legacyImporter)),
  )
  const launch = Launch.layer.pipe(Layer.provideMerge(threads))
  const recovery = Recovery.layer.pipe(Layer.provideMerge(shared))
  const effectExecutor = Worker.layerExecutor.pipe(Layer.provideMerge(threads))
  const worker = Worker.layer.pipe(Layer.provideMerge(effectExecutor))
  // Explicit opt-in: the original continuation layer starts its scoped queue consumer.
  const continuationConsumer = Continuations.layer.pipe(Layer.provide(threads))
  return { state, shared, providerEvents, sessions, checkpointCapture, finalization,
    turns, decisions, legacyImporter, orchestrator, threads, launch, recovery,
    effectExecutor, worker, continuationConsumer, layer: Layer.mergeAll(launch, recovery) }
}

export { IdAllocator, ContinuationRequests, ThreadCommandExecutor, Orchestrator, Launch,
  Policy, CommandPolicy, Forks, Handoffs, Adapters, Switches, Output, Recovery, Continuations, Worker }
export * as Threads from 't3-source:apps/server/src/orchestration-v2/ThreadManagementService.session-api.ts'
export { layerWithLegacyImporter as threadManagementLayer }
  from 't3-source:apps/server/src/orchestration-v2/ThreadManagementLive.ts'
export * as ThreadMessageIntake from 't3-source:apps/server/src/orchestration-v2/ThreadMessageIntake.ts'
export * as AttachmentClaims from 't3-source:apps/server/src/orchestration-v2/AttachmentClaims.ts'
export * as ProviderSessions from 't3-source:apps/server/src/orchestration-v2/ProviderSessionManager.session-port.ts'
export * as ProviderDirectory from 't3-source:apps/server/src/provider/ProviderInstanceRegistry.session-port.ts'
export * as Settings from 't3-source:apps/server/src/serverSettings.session-port.ts'
export * as ProjectClones from 't3-source:apps/server/src/project/ProjectCloneTracker.session-port.ts'
export * as ProviderCatalog from 't3-source:apps/server/src/provider/ProviderRegistry.session-port.ts'
export * as TextGeneration from 't3-source:apps/server/src/textGeneration/TextGeneration.session-port.ts'
export * as Terminals from 't3-source:apps/server/src/terminal/Manager.session-port.ts'
export * as Config from 't3-source:apps/server/src/config.session-port.ts'
export * as Checkpoints from 't3-source:apps/server/src/orchestration-v2/CheckpointService.session-port.ts'
export * as ResourceOwners from 't3-source:apps/server/src/orchestration-v2/ResourceCleanupService.session-port.ts'
export * as Finalization from 't3-source:apps/server/src/orchestration-v2/RunFinalizationService.session-port.ts'
export * as TurnStart from 't3-source:apps/server/src/orchestration-v2/ProviderTurnStartService.session-port.ts'
export * as TurnControl from 't3-source:apps/server/src/orchestration-v2/ProviderTurnControlService.session-port.ts'
export { ControlLive as SessionTurnControl, RequestsLive as SessionRuntimeRequests }
export { SessionsLive as SessionProviderSessions, ProviderEvents, CheckpointCapture,
  FinalizationLive as SessionRunFinalization }
// Construction hydrates original instances. Build only after finite native/command
// admission; inspection must use the held original settings codecs instead.
export * as SessionProviderDirectory from 't3-source:apps/server/src/provider/ProviderInstanceRegistry.session-live.ts'
export * as RuntimeRequests from 't3-source:apps/server/src/orchestration-v2/RuntimeRequestService.session-port.ts'
export * as Rollback from 't3-source:apps/server/src/orchestration-v2/CheckpointRollbackService.session-port.ts'
export * as Titles from 't3-source:apps/server/src/orchestration-v2/ThreadTitleRegenerationService.session-port.ts'
// T13 must implement this original service through canonical authorized vault save/use plus scoped ephemeral delivery.
export * as SecretRequests from 't3-source:apps/server/src/secrets/SecretRequests.session-port.ts'
