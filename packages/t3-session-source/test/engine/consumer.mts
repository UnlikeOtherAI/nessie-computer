import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import { createSessionReadLayers, createSessionEngineLayers, ProviderSessions, ResourceOwners, Settings,
  ProjectionStore, EventSink, ThreadMessageIntake, SecretRequests, ThreadReadService, Sqlite,
  EnvironmentIdentity, type SessionStateServices, LegacyImporter, SourceContracts } from '@nessie/t3-session-source/engine'
import { ThreadId } from '@nessie/t3-session-source/contracts'

type Input<T> = T extends Layer.Layer<infer _Out, infer _Error, infer Required> ? Required : never
type Services<T> = T extends Effect.Effect<infer _Out, infer _Error, infer Required> ? Required : never
type Reads = Input<ReturnType<typeof createSessionReadLayers>['layer']>
type Engine = Input<ReturnType<typeof createSessionEngineLayers>['layer']>
type Worker = Input<ReturnType<typeof createSessionEngineLayers>['worker']>
type Shared = Input<ReturnType<typeof createSessionEngineLayers>['shared']>
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
type Command = Parameters<typeof ThreadMessageIntake.dispatchCommand>[0]
// @ts-expect-error Original source command discriminants survive the generated boundary.
const invalidCommand: Command = { type: 'invented-command' }
type SecretAnswer = Parameters<SecretRequests.SecretRequests['Service']['answer']>[0]
// @ts-expect-error The original dedicated schema cannot be replaced with an ordinary value.
const invalidSecret: SecretAnswer = { value: 'synthetic-only' }
void [readSqlRequired, readProviderRequired, engineProviderRequired, engineSettingsRequired, workerCleanupRequired,
  sharedSqlRequired, sharedProjectionRequired, engineEventSinkRequired, exactReadLayer, transcriptIdentityRequired,
  fileSystemRequired, pathRequired, sharedOriginalId, invalidCommand, invalidSecret]
