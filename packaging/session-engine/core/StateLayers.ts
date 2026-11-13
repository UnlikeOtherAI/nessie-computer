// Persistence composition adapted from T3 Code runtimeLayer.ts at
// 25bf84ab07f53f141c20239c63e383823a9d5ea0 (MIT, Copyright 2026 T3 Tools Inc.).
// The original notice is retained in THIRD_PARTY_NOTICES.md and every source capsule.
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import * as ApplicationEvents from 't3-source:apps/server/src/persistence/OrchestrationEventStore.ts'
import * as ApplicationReceipts from 't3-source:apps/server/src/persistence/OrchestrationCommandReceipts.ts'
import * as EventStore from 't3-source:apps/server/src/orchestration-v2/EventStore.ts'
import * as CommandReceipts from 't3-source:apps/server/src/orchestration-v2/CommandReceiptStore.ts'
import * as ProjectionStore from 't3-source:apps/server/src/orchestration-v2/ProjectionStore.ts'
import * as ProjectStore from 't3-source:apps/server/src/orchestration-v2/ProjectStore.ts'
import * as Outbox from 't3-source:apps/server/src/orchestration-v2/EffectOutbox.ts'
import * as TurnPositions from 't3-source:apps/server/src/orchestration-v2/TurnItemPositionStore.ts'
import * as EventSink from 't3-source:apps/server/src/orchestration-v2/EventSink.ts'
export { ORCHESTRATION_PROTOCOL_VERSION } from 't3-source:packages/contracts/src/environment.ts'

export type SessionStateServices = ApplicationEvents.OrchestrationEventStore
  | ApplicationReceipts.OrchestrationCommandReceiptRepository
  | EventStore.EventStoreV2 | CommandReceipts.CommandReceiptStoreV2
  | ProjectionStore.ProjectionStoreV2 | ProjectStore.ProjectStoreV2
  | Outbox.EffectOutboxV2 | TurnPositions.TurnItemPositionStoreV2 | EventSink.EventSinkV2

/**
 * Build real upstream persistence services over the owner's SQL layer. Keep
 * these references when composing the orchestrator/effect worker: constructing
 * another outbox loses the in-memory wakeup lane shared with the event sink.
 * This does not run a provider, HTTP server, recovery worker or credential store.
 */
export const createSessionStateLayers = () => {
  const infrastructure = Layer.mergeAll(ApplicationEvents.layer, ApplicationReceipts.layer)
  const stores = Layer.mergeAll(
    infrastructure,
    EventStore.layerFromOrchestrationEventStore.pipe(Layer.provide(infrastructure)),
    CommandReceipts.layerFromApplicationReceipts.pipe(Layer.provide(infrastructure)),
    ProjectionStore.layer,
    ProjectStore.layer,
    Outbox.layer,
    TurnPositions.layer,
  )
  const eventSink = EventSink.layerFromStores.pipe(Layer.provide(stores))
  const layer: Layer.Layer<SessionStateServices, never, SqlClient.SqlClient> = Layer.mergeAll(stores, eventSink)
  return { infrastructure, stores, eventSink, outbox: Outbox.layer, layer }
}

// Consumers use these same Context identities, not parallel store adapters.
export { ApplicationEvents, ApplicationReceipts, EventStore, CommandReceipts, ProjectionStore,
  ProjectStore, Outbox, TurnPositions, EventSink }
