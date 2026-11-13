import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { CommandId, ContextTransferId, EventId, ProjectId, RunId, ThreadId,
  type OrchestrationV2DomainEvent, type OrchestrationV2Run } from 't3-source:packages/contracts/src/index.ts'
import * as Forks from 't3-source:apps/server/src/orchestration-v2/ThreadForkService.ts'
import { EventSink } from './StateLayers.ts'
import { LegacyImporter, ThreadReadService } from './ReadLayers.ts'

export const historyThreadId = ThreadId.make('history:thread:000')
export const historyProjectId = ProjectId.make('history:project')
export const historyMessageCount = 360
export const historyThreadCount = 160

/** Synthetic legacy rows only. The real importer creates domain events, messages and turn items. */
export const seedHistoryFixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(Effect.gen(function* () {
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${historyProjectId}, 'Synthetic retained project', '/synthetic/never-executed', '[]',
        '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`
    for (let index = 0; index < historyThreadCount; index++) {
      const id = `history:thread:${String(index).padStart(3, '0')}`
      const archived = index >= 150 ? '2025-02-01T00:00:00.000Z' : null
      const settled = index < 60 ? 'settled' : null
      // Tied times test the original stable id cursor, beyond the shell's newest 25.
      const settledAt = index < 60 ? new Date(Date.UTC(2025, 0, 2 + Math.floor(index / 3))).toISOString() : null
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, settled_override, settled_at)
        VALUES (${id}, ${historyProjectId}, ${`Retained ${index}`},
          '{"instanceId":"synthetic-unbound","model":"never-executed"}', 'approval-required', 'default',
          '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', ${archived}, ${settled}, ${settledAt})`
    }
    for (let index = 0; index < historyMessageCount; index++) {
      const time = new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString()
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`history:message:${index}`}, ${historyThreadId}, ${index % 2 ? 'assistant' : 'user'},
          ${index === 0 ? '**Dávná zpráva** oldest searchable marker' : `Synthetic retained message ${index}`},
          0, ${time}, ${time})`
    }
  }))
  const importer = yield* LegacyImporter.LegacyV1ThreadImporter
  return yield* importer.reconcileShells
})

/** Add a completed source run and use the original fork planner, retaining inherited item identities. */
export const seedLineageFixture = Effect.gen(function* () {
  const reads = yield* ThreadReadService
  const sink = yield* EventSink.EventSinkV2
  const forks = yield* Forks.ThreadForkServiceV2
  const original = yield* reads.getThreadProjection(historyThreadId)
  const anchor = original.turnItems.at(-1)
  if (!anchor || anchor.type !== 'assistant_message') return yield* Effect.die('Synthetic legacy anchor is missing.')
  const at = DateTime.makeUnsafe('2025-03-01T00:00:00.000Z')
  const run: OrchestrationV2Run = {
    id: RunId.make('history:completed-run'), threadId: historyThreadId, ordinal: 1,
    providerInstanceId: original.thread.providerInstanceId, modelSelection: original.thread.modelSelection,
    providerThreadId: null, userMessageId: original.messages[0]!.id, rootNodeId: null, activeAttemptId: null,
    status: 'completed', requestedAt: at, startedAt: at, completedAt: at, checkpointId: null, contextHandoffId: null,
  }
  const event = (suffix: string) => ({ id: EventId.make(`history:${suffix}`), occurredAt: at })
  // Exact source event schemas are validated by EventSink encoding before persistence.
  const events: OrchestrationV2DomainEvent[] = [
    { ...event('run'), type: 'run.created', threadId: historyThreadId, payload: run },
    { ...event('anchor'), type: 'turn-item.updated', threadId: historyThreadId, payload: { ...anchor, runId: run.id } },
  ]
  yield* sink.commitCommand({ commandId: CommandId.make('history:anchor-command'), threadId: historyThreadId,
    commandType: 'synthetic-fixture', acceptedAt: at, events, effects: [] })
  const forkId = ThreadId.make('history:fork')
  const plan = yield* forks.plan({ sourceProjection: original, sourceRun: run, sourceProviderThread: undefined,
    canonicalSourcePoint: { threadId: historyThreadId, runId: run.id },
    transferId: ContextTransferId.make('history:fork-transfer'), targetThreadId: forkId,
    createdBy: 'user', creationSource: 'web', createdAt: at })
  const childId = ThreadId.make('history:child')
  yield* sink.commitCommand({ commandId: CommandId.make('history:lineage-command'), threadId: forkId,
    commandType: 'synthetic-fixture', acceptedAt: at,
    events: [{ ...event('fork-created'), type: 'thread.created', threadId: forkId, payload: plan.targetThread },
      { ...event('fork-transfer'), type: 'context-transfer.created', threadId: forkId, payload: plan.transfer },
      { ...event('child-created'), type: 'thread.created', threadId: childId, payload: {
        ...plan.targetThread, id: childId, forkedFrom: null,
        lineage: { parentThreadId: historyThreadId, relationshipToParent: 'subagent', rootThreadId: historyThreadId },
      } }], effects: [] })
  return { forkId, childId, run }
})

export { Forks }
