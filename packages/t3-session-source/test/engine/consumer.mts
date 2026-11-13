import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import { createSessionReadLayers, createSessionEngineLayers, createSessionEngineLayersWithAdapters,
  makeSessionEngineGraphWithAdapters,
  ProviderSessions, ProviderDirectory, ResourceOwners, Settings, Adapters, SelectedCodex, SelectedClaude,
  Policy, ProviderEvents,
  ProjectionStore, EventSink, ThreadMessageIntake, SecretRequests, ThreadReadService, Sqlite, RequestPrivacy,
  EnvironmentIdentity, type SessionStateServices, LegacyImporter, SourceContracts,
  SessionControl, Threads, Launch, CommandLineage, EffectClaims, Outbox, ScheduledTasks }
  from '@nessie/t3-session-source/engine'
import { ThreadId } from '@nessie/t3-session-source/contracts'
import { createSessionRuntimeLayers, ProviderHost, NativeChildProcesses,
  ProviderCredentialReferences, SessionResourceTargets, TurnControl, RuntimeRequests,
  sessionProviderHostLayer, SessionLifecycleAuthority, type SessionLifecycleAction } from '@nessie/t3-session-source/engine'

type Input<T> = T extends Layer.Layer<infer _Out, infer _Error, infer Required> ? Required : never
type Services<T> = T extends Effect.Effect<infer _Out, infer _Error, infer Required> ? Required : never
type Reads = Input<ReturnType<typeof createSessionReadLayers>['layer']>
type Engine = Input<ReturnType<typeof createSessionEngineLayers>['layer']>
type Worker = Input<ReturnType<typeof createSessionEngineLayers>['worker']>
type Shared = Input<ReturnType<typeof createSessionEngineLayers>['shared']>
type Runtime = Input<ReturnType<typeof createSessionRuntimeLayers>['layer']>
const runtimeHostRequired: ProviderHost.ProviderHost extends Runtime ? true : false = false
const runtimeCredentialsRequired: ProviderCredentialReferences extends Runtime ? true : false = false
const runtimeResourceOwnersRequired: SessionResourceTargets extends Runtime ? true : false = true
const runtimeControlRequired: TurnControl.ProviderTurnControlServiceV2 extends Runtime ? true : false = false
const runtimeRequestsRequired: RuntimeRequests.RuntimeRequestServiceV2 extends Runtime ? true : false = false
type Host = Input<typeof sessionProviderHostLayer>
const hostCredentialProducerRequired: ProviderCredentialReferences extends Host ? true : false = true
const noRawCredentials: 'credentials' extends keyof ProviderHost.ProviderHost['Service'] ? false : true = true
const runtimeNativeRequired: NativeChildProcesses.ChildProcessSpawner extends Runtime ? true : false = false
const runtimeProviderRequired: ProviderSessions.ProviderSessionManagerV2 extends Runtime ? true : false = false
const runtimeDirectoryRequired: ProviderDirectory.ProviderInstanceRegistry extends Runtime ? true : false = true
const runtimeCleanupRequired: ResourceOwners.ResourceCleanupService extends Runtime ? true : false = false
const readSqlRequired: SqlClient.SqlClient extends Reads ? true : false = true
const readProviderRequired: ProviderSessions.ProviderSessionManagerV2 extends Reads ? true : false = false
const engineProviderRequired: ProviderSessions.ProviderSessionManagerV2 extends Engine ? true : false = false
const engineDirectoryRequired: ProviderDirectory.ProviderInstanceRegistry extends Engine ? true : false = true
type ProtectedEngine = Input<ReturnType<typeof createSessionEngineLayersWithAdapters>['layer']>
type ColdShellPlan = Services<Effect.Success<typeof makeSessionEngineGraphWithAdapters>['legacyShells']>
const coldShellSqlRequired: SqlClient.SqlClient extends ColdShellPlan ? true : false = true
const coldShellProviderRequired: ProviderSessions.ProviderSessionManagerV2 extends ColdShellPlan ? true : false = false
// @ts-expect-error Metadata cannot mint the scoped original reconciliation candidate.
const unissuedShellPlan: LegacyImporter.LegacyShellReconciliationCandidate = { observedAtMs: 0, targets: [], planDigest: '' }
const protectedAdapterRequired: Adapters.ProviderAdapterRegistryV2 extends ProtectedEngine ? true : false = true
const protectedPolicyRequired: Policy.RuntimePolicyV2 extends ProtectedEngine ? true : false = true
const protectedFullDirectoryRequired: ProviderDirectory.ProviderInstanceRegistry extends ProtectedEngine ? true : false = false
type EventPorts = Input<typeof ProviderEvents.layer>
const eventsNeedNoProductDirectory: ProviderDirectory.ProviderInstanceRegistry extends EventPorts ? true : false = false
type CodexExecution = Services<ReturnType<ReturnType<typeof SelectedCodex.makeSelectedCodexExecutionDriver>['create']>>
type ClaudeExecution = Services<ReturnType<ReturnType<typeof SelectedClaude.makeSelectedClaudeExecutionDriver>['create']>>
// Default Context references are structurally broad. Check actual union members,
// rather than whether an unrelated service is assignable to a default reference.
type RequiresCodexProduct = Extract<CodexExecution, SelectedCodex.SelectedCodexServices>
type RequiresClaudeProduct = Extract<ClaudeExecution, SelectedClaude.SelectedClaudeServices>
const codexFullProductRequired: RequiresCodexProduct extends never ? false : true = false
const claudeFullProductRequired: RequiresClaudeProduct extends never ? false : true = false
type CodexSpawner = Extract<CodexExecution, NativeChildProcesses.ChildProcessSpawner>
type ClaudeSpawner = Extract<ClaudeExecution, NativeChildProcesses.ChildProcessSpawner>
const codexGenericSpawnerRequired: CodexSpawner extends never ? false : true = false
const claudeSpawnerRequired: ClaudeSpawner extends never ? false : true = true
// @ts-expect-error A full provider snapshot cannot replace the execution adapter registry.
const invalidExecutionRegistry: Adapters.ProviderAdapterRegistryV2['Service'] = { snapshot: {} }
const engineSettingsRequired: Settings.ServerSettingsService extends Engine ? true : false = true
const engineLineageRequired: CommandLineage.SessionCommandLineage extends Engine ? true : false = true
const readsNeedNoLineage: CommandLineage.SessionCommandLineage extends Reads ? true : false = false
const workerCleanupRequired: ResourceOwners.ResourceCleanupService extends Worker ? true : false = true
const workerClaimOwnerRequired: EffectClaims.SessionEffectClaimAuthority extends Worker ? true : false = true
const runtimeClaimOwnerRequired: EffectClaims.SessionEffectClaimAuthority extends Runtime ? true : false = true
const runtimeLifecycleOwnerRequired: SessionLifecycleAuthority extends Runtime ? true : false = true
const readsNeedNoLifecycleOwner: SessionLifecycleAuthority extends Reads ? true : false = false
// @ts-expect-error A lease/preclaim phase cannot replace a concrete lifecycle action.
const invalidLifecycleAction: SessionLifecycleAction = 'claim-original-provider-turn-start'
const readsNeedNoClaimOwner: EffectClaims.SessionEffectClaimAuthority extends Reads ? true : false = false
declare const decodedPendingEffect: Outbox.OrchestrationEffectV2
// @ts-expect-error A decoded pending effect is not the scoped original claim candidate.
const unsealedClaim: Outbox.OrchestrationEffectClaimCandidate = { effect: decodedPendingEffect }
const sharedSqlRequired: SqlClient.SqlClient extends Shared ? true : false = true
const sharedProjectionRequired: ProjectionStore.ProjectionStoreV2 extends Shared ? true : false = false
const engineEventSinkRequired: EventSink.EventSinkV2 extends Engine ? true : false = false
const exactReadLayer: Layer.Layer<SessionStateServices | LegacyImporter.LegacyV1ThreadImporter | ThreadReadService,
  never, SqlClient.SqlClient> = createSessionReadLayers().layer
type Transcript = Services<ReturnType<ThreadReadService['Service']['getThreadTranscript']>>
const transcriptIdentityRequired: EnvironmentIdentity.ServerEnvironmentIdentity extends Transcript ? true : false = true
type SqlitePorts = Input<ReturnType<typeof Sqlite.layerFromPath>>
const fileSystemRequired: FileSystem.FileSystem extends SqlitePorts ? true : false = true
const pathRequired: Path.Path extends SqlitePorts ? true : false = true
const sharedOriginalId: SourceContracts.ThreadId = ThreadId.make('opaque:consumer')
const retainedProjector: (value: unknown) => unknown = RequestPrivacy.createRequestPrivacyProjector()
type Command = Parameters<typeof ThreadMessageIntake.dispatchCommand>[0]
// @ts-expect-error Original source command discriminants survive the generated boundary.
const invalidCommand: Command = { type: 'invented-command' }

type ControlPorts = Services<ReturnType<typeof SessionControl.dispatchCommand>>
const controlNeedsThreads: Threads.ThreadManagementService extends ControlPorts ? true : false = true
const controlNeedsLaunch: Launch.ThreadLaunchService extends ControlPorts ? true : false = true
type ScheduleService = ScheduledTasks.ScheduledTaskService['Service']
type ScheduleInput = Parameters<ScheduleService['runNow']>[0]
// @ts-expect-error The original schedule ID cannot be substituted with a thread field.
const invalidSchedule: ScheduleInput = { threadId: ThreadId.make('not-a-schedule') }
type SecretAnswer = Parameters<SecretRequests.SecretRequests['Service']['answer']>[0]
// @ts-expect-error The original dedicated schema cannot be replaced with an ordinary value.
const invalidSecret: SecretAnswer = { value: 'synthetic-only' }
void [readSqlRequired, readProviderRequired, engineProviderRequired, engineSettingsRequired, workerCleanupRequired,
  workerClaimOwnerRequired, runtimeClaimOwnerRequired, readsNeedNoClaimOwner, unsealedClaim,
  runtimeLifecycleOwnerRequired, readsNeedNoLifecycleOwner, invalidLifecycleAction,
  engineLineageRequired, readsNeedNoLineage,
  runtimeHostRequired, runtimeNativeRequired, runtimeProviderRequired, runtimeCleanupRequired,
  runtimeDirectoryRequired, engineDirectoryRequired,
  protectedAdapterRequired, protectedPolicyRequired, protectedFullDirectoryRequired, eventsNeedNoProductDirectory,
  coldShellSqlRequired, coldShellProviderRequired, unissuedShellPlan,
  codexFullProductRequired, claudeFullProductRequired,
  codexGenericSpawnerRequired, claudeSpawnerRequired,
  invalidExecutionRegistry,
  runtimeCredentialsRequired, runtimeResourceOwnersRequired, runtimeControlRequired, runtimeRequestsRequired,
  hostCredentialProducerRequired, noRawCredentials,
  sharedSqlRequired, sharedProjectionRequired, engineEventSinkRequired, exactReadLayer, transcriptIdentityRequired,
  fileSystemRequired, pathRequired, sharedOriginalId, invalidCommand, invalidSecret, retainedProjector,
  controlNeedsThreads, controlNeedsLaunch, invalidSchedule]
