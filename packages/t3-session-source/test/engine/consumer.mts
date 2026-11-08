import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import { createSessionReadLayers, createSessionEngineLayers, ProviderSessions, ResourceOwners, Settings,
  ProjectionStore, EventSink, ThreadMessageIntake, SecretRequests, ThreadReadService, Sqlite, RequestPrivacy,
  EnvironmentIdentity, type SessionStateServices, LegacyImporter, SourceContracts } from '@nessie/t3-session-source/engine'
import { ThreadId } from '@nessie/t3-session-source/contracts'
import { createSessionRuntimeLayers, ProviderHost, NativeChildProcesses,
  ProviderCredentialReferences, SessionResourceTargets, TurnControl, RuntimeRequests,
  sessionProviderHostLayer } from '@nessie/t3-session-source/engine'

type Input<T> = T extends Layer.Layer<infer _Out, infer _Error, infer Required> ? Required : never
type Services<T> = T extends Effect.Effect<infer _Out, infer _Error, infer Required> ? Required : never
type Reads = Input<ReturnType<typeof createSessionReadLayers>['layer']>
type Engine = Input<ReturnType<typeof createSessionEngineLayers>['layer']>
type Worker = Input<ReturnType<typeof createSessionEngineLayers>['worker']>
type Shared = Input<ReturnType<typeof createSessionEngineLayers>['shared']>
type Runtime = Input<ReturnType<typeof createSessionRuntimeLayers>['layer']>
const runtimeHostRequired: ProviderHost.ProviderHost extends Runtime ? true : false = false
const runtimeCredentialsRequired: ProviderCredentialReferences extends Runtime ? true : false = true
const runtimeResourceOwnersRequired: SessionResourceTargets extends Runtime ? true : false = true
const runtimeControlRequired: TurnControl.ProviderTurnControlServiceV2 extends Runtime ? true : false = false
const runtimeRequestsRequired: RuntimeRequests.RuntimeRequestServiceV2 extends Runtime ? true : false = false
type Host = Input<typeof sessionProviderHostLayer>
const hostCredentialProducerRequired: ProviderCredentialReferences extends Host ? true : false = true
const noRawCredentials: 'credentials' extends keyof ProviderHost.ProviderHost['Service'] ? false : true = true
const runtimeNativeRequired: NativeChildProcesses.ChildProcessSpawner extends Runtime ? true : false = true
const runtimeProviderRequired: ProviderSessions.ProviderSessionManagerV2 extends Runtime ? true : false = true
const runtimeCleanupRequired: ResourceOwners.ResourceCleanupService extends Runtime ? true : false = false
const readSqlRequired: SqlClient.SqlClient extends Reads ? true : false = true
const readProviderRequired: ProviderSessions.ProviderSessionManagerV2 extends Reads ? true : false = false
const engineProviderRequired: ProviderSessions.ProviderSessionManagerV2 extends Engine ? true : false = true
const engineSettingsRequired: Settings.ServerSettingsService extends Engine ? true : false = true
const workerCleanupRequired: ResourceOwners.ResourceCleanupService extends Worker ? true : false = true
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
type SecretAnswer = Parameters<SecretRequests.SecretRequests['Service']['answer']>[0]
// @ts-expect-error The original dedicated schema cannot be replaced with an ordinary value.
const invalidSecret: SecretAnswer = { value: 'synthetic-only' }
void [readSqlRequired, readProviderRequired, engineProviderRequired, engineSettingsRequired, workerCleanupRequired,
  runtimeHostRequired, runtimeNativeRequired, runtimeProviderRequired, runtimeCleanupRequired,
  runtimeCredentialsRequired, runtimeResourceOwnersRequired, runtimeControlRequired, runtimeRequestsRequired,
  hostCredentialProducerRequired, noRawCredentials,
  sharedSqlRequired, sharedProjectionRequired, engineEventSinkRequired, exactReadLayer, transcriptIdentityRequired,
  fileSystemRequired, pathRequired, sharedOriginalId, invalidCommand, invalidSecret, retainedProjector]
