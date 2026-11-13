import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { DEFAULT_SERVER_SETTINGS } from '@nessie/t3-session-source/contracts/settings'
import { EventSink, IdAllocator, OriginalCodexAdapter, Recovery, Settings } from '@nessie/t3-session-source/engine'

// Synthetic records through the actual original event codecs, stores and SQL.
// The structural thread pattern follows upstream FoundationPersistence.test.ts
// (T3 25bf84ab, MIT). No provider, native identity or human grant is established.
export const shutdownSettings = { ...DEFAULT_SERVER_SETTINGS, continueThreadsAfterServerUpdate: true }
export const seedShutdownThread = id => Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2
  const at = DateTime.makeUnsafe('2026-11-01T00:00:00.000Z')
  const modelSelection = { instanceId: 'codex', model: 'synthetic' }
  const thread = { createdBy: 'user', creationSource: 'web', id, projectId: `project:${id}`,
    title: `Synthetic ${id}`, providerInstanceId: 'codex', modelSelection, runtimeMode: 'full-access',
    interactionMode: 'default', branch: null, worktreePath: null, activeProviderThreadId: `provider:${id}`,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, forkedFrom: null,
    createdAt: at, updatedAt: at, archivedAt: null, settledOverride: null, settledAt: null,
    lastVisitedAt: null, deletedAt: null }
  const run = { id: `run:${id}`, threadId: id, ordinal: 1, providerInstanceId: 'codex', modelSelection,
    providerThreadId: `provider:${id}`, userMessageId: `message:${id}`, rootNodeId: `node:${id}`,
    activeAttemptId: `attempt:${id}`, status: 'running', queuePosition: null,
    requestedAt: at, startedAt: at, completedAt: null, checkpointId: null, contextHandoffId: null }
  const providerThread = { id: `provider:${id}`, driver: 'codex', providerInstanceId: 'codex',
    providerSessionId: `session:${id}`, appThreadId: id, ownerNodeId: null, status: 'active',
    nativeThreadRef: { driver: 'codex', nativeId: `native:${id}`, strength: 'strong' },
    nativeConversationHeadRef: null,
    firstRunOrdinal: 1, lastRunOrdinal: 1, handoffIds: [], forkedFrom: null, createdAt: at, updatedAt: at }
  const providerSession = { id: `session:${id}`, driver: 'codex', providerInstanceId: 'codex',
    status: 'ready', cwd: 'C:/synthetic/never-executed', model: 'synthetic',
    capabilities: OriginalCodexAdapter.CodexProviderCapabilitiesV2,
    createdAt: at, updatedAt: at, lastError: null }
  const providerTurn = { id: `turn:${id}`, providerThreadId: providerThread.id, nodeId: `node:${id}`,
    runAttemptId: run.activeAttemptId, nativeTurnRef: null, ordinal: 1, status: 'running',
    startedAt: at, completedAt: null }
  const attempt = { id: run.activeAttemptId, runId: run.id, attemptOrdinal: 1, rootNodeId: `node:${id}`,
    providerInstanceId: 'codex', providerThreadId: providerThread.id, providerTurnId: providerTurn.id,
    reason: 'initial', status: 'running', startedAt: at, completedAt: null }
  const values = [['thread.created', thread], ['provider-session.updated', providerSession],
    ['provider-thread.updated', providerThread], ['run.created', run], ['run-attempt.created', attempt],
    ['provider-turn.updated', providerTurn]]
  yield* sink.writeWithEffects({ commandId: `seed:${id}`, effects: [], events: values.map(([type, payload], index) => ({
    id: `seed:${id}:${index}`, type, threadId: id, driver: 'codex', providerInstanceId: 'codex', occurredAt: at, payload,
  })) })
})
export const shutdownRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY effect_id COLLATE BINARY`).map(r => ({ ...r }))
})
export const makeShutdownRecovery = (getSettings = Effect.succeed(shutdownSettings), sink) => Recovery.make.pipe(
  Effect.provideService(Settings.ServerSettingsService, { getSettings }), Effect.provide(IdAllocator.layer),
  ...(sink ? [Effect.provideService(EventSink.EventSinkV2, sink)] : []),
)
export const shutdownDeadline = (plan, duration = 2000) => {
  const remaining = Math.min(duration, plan.observedAtMs + 4500 - Date.now())
  return { notAfterMs: Date.now() + remaining, notAfterMonotonicMs: performance.now() + remaining }
}
