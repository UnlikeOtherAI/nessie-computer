// Original operations extracted from pinned MIT T3 source; no alternate projection or history implementation.
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as OrchestratorReads from 't3-source:apps/server/src/orchestration-v2/OrchestratorReads.ts'
import * as ThreadReads from 't3-source:apps/server/src/orchestration-v2/ThreadReads.ts'
import * as ReadTag from 't3-source:apps/server/src/orchestration-v2/ThreadReadsTag.ts'
import * as LegacyImporter from 't3-source:apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts'
import { createSessionStateLayers, EventSink, ProjectionStore } from './StateLayers.ts'

/** No provider, effect consumer, command admission, recovery or imported executable work is started. */
export const createSessionReadLayers = (state = createSessionStateLayers()) => {
  const legacyImporter = LegacyImporter.layer.pipe(Layer.provide(state.layer))
  const reads = Layer.effect(ReadTag.ThreadManagementService, Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2
    const sink = yield* EventSink.EventSinkV2
    const legacy = yield* LegacyImporter.LegacyV1ThreadImporter
    return ThreadReads.makeThreadReads(OrchestratorReads.makeOrchestratorReads(projections, sink), legacy)
  })).pipe(Layer.provide(Layer.mergeAll(state.layer, legacyImporter)))
  return { state, legacyImporter, reads, layer: Layer.mergeAll(state.layer, legacyImporter, reads) }
}

export { OrchestratorReads, ThreadReads, LegacyImporter }
export { ThreadManagementService as ThreadReadService } from 't3-source:apps/server/src/orchestration-v2/ThreadReadsTag.ts'
export * as SessionSync from 't3-source:apps/server/src/sessionSync.ts'
export * as ShellStream from 't3-source:apps/server/src/orchestration-v2/ShellStream.ts'
export * as ThreadStream from 't3-source:apps/server/src/orchestration-v2/ThreadStream.ts'
export * as WireProjection from 't3-source:apps/server/src/orchestration-v2/WireProjection.ts'
export * as HistoryPaging from 't3-source:apps/server/src/orchestration-v2/threadHistoryPaging.ts'
export * as ThreadFind from 't3-source:apps/server/src/orchestration-v2/ThreadFind.ts'
export * as ThreadSearch from 't3-source:apps/server/src/orchestration-v2/ThreadSearch.ts'
export * as Sqlite from 't3-source:apps/server/src/persistence/Sqlite.ts'
export * as EnvironmentIdentity from 't3-source:apps/server/src/environment/ServerEnvironment.session-port.ts'
export * as ProjectEnrichment from 't3-source:apps/server/src/project/ProjectEnrichmentService.session-port.ts'
export * as Projects from 't3-source:apps/server/src/project/ProjectService.session-port.ts'
