import assert from 'node:assert/strict'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as Stream from 'effect/Stream'
import { CommandId, EventId, OrchestrationV2ThreadStreamItem } from 't3-source:packages/contracts/src/index.ts'
import { ApplicationEvents, EventSink } from './StateLayers.ts'
import { SessionSync, ThreadReadService } from './ReadLayers.ts'
import { historyThreadId } from './HistoryFixture.ts'

/** Real persisted replay/live handoff and authoritative recovery, never a replay testkit. */
export const qualifyThreadSync = Effect.gen(function* () {
  const reads = yield* ThreadReadService
  const sink = yield* EventSink.EventSinkV2
  const applicationEvents = yield* ApplicationEvents.OrchestrationEventStore
  const sql = yield* SqlClient.SqlClient
  const rename = (suffix: string) => Effect.gen(function* () {
    const { projection } = yield* reads.getThreadSnapshotWindow(historyThreadId, { rowLimit: 1 })
    const at = yield* DateTime.now
    return yield* sink.commitCommand({ commandId: CommandId.make(`history:rename:${suffix}`),
      threadId: historyThreadId, commandType: 'synthetic-fixture', acceptedAt: at, effects: [],
      events: [{ id: EventId.make(`history:rename-event:${suffix}`), type: 'thread.metadata-updated',
        threadId: historyThreadId, occurredAt: at, payload: { ...projection.thread, title: `Synthetic ${suffix}` } }] })
  })
  const afterSequence = yield* reads.getThreadEventSequence(historyThreadId)
  const replayed = yield* rename('replay')
  const prepared = yield* SessionSync.subscribeOrchestrationV2Thread({ threadId: historyThreadId,
    afterSequence, requestCompletionMarker: true, acceptBoundedSnapshot: true,
    acceptDeferredWork: true, acceptCompactIds: true, acceptDedupedBodies: true })
  // Commit after the subscription's high-water read, before downstream consumes the live tail.
  const raced = yield* rename('handoff-race')
  const frames = yield* prepared.pipe(Stream.take(3), Stream.runCollect, Effect.timeout('10 seconds'))
  assert.deepEqual(frames.map(frame => frame.kind), ['event', 'synchronized', 'event'])
  const sequences = frames.flatMap(frame => frame.kind === 'event' ? [frame.sequence] : [])
  assert.deepEqual(sequences, [replayed.receipt.resultSequence, raced.receipt.resultSequence])
  for (const frame of frames) {
    const encoded = yield* Schema.encodeEffect(OrchestrationV2ThreadStreamItem)(frame)
    assert.equal((yield* Schema.decodeUnknownEffect(OrchestrationV2ThreadStreamItem)(encoded)).kind, frame.kind)
  }
  const future = yield* SessionSync.subscribeOrchestrationV2Thread({ threadId: historyThreadId,
    afterSequence: raced.receipt.resultSequence + 1, requestCompletionMarker: true, acceptBoundedSnapshot: true })
  const recovered = yield* future.pipe(Stream.take(2), Stream.runCollect, Effect.timeout('10 seconds'))
  assert.deepEqual(recovered.map(frame => frame.kind), ['snapshot', 'synchronized'])
  // Synthetic pruning publishes the same authoritative source marker and then removes an old row.
  const highWater = yield* reads.getThreadEventSequence(historyThreadId)
  yield* sql`INSERT INTO orchestration_v2_projection_metadata
    (projection_name, schema_version, last_sequence, updated_at)
    SELECT ${ApplicationEvents.EVENT_LOG_PRUNED_THROUGH}, schema_version, ${highWater}, '2026-01-01T00:00:00.000Z'
    FROM orchestration_v2_projection_metadata WHERE projection_name = 'thread-projections'
    ON CONFLICT(projection_name) DO UPDATE SET last_sequence = excluded.last_sequence`
  yield* sql`DELETE FROM orchestration_events WHERE sequence = ${replayed.receipt.resultSequence}`
  assert.equal(yield* applicationEvents.prunedThroughSequence, highWater)
  const stale = yield* SessionSync.subscribeOrchestrationV2Thread({ threadId: historyThreadId,
    afterSequence, requestCompletionMarker: true, acceptBoundedSnapshot: true })
  const resynced = yield* stale.pipe(Stream.take(2), Stream.runCollect, Effect.timeout('10 seconds'))
  assert.deepEqual(resynced.map(frame => frame.kind), ['snapshot', 'synchronized'])
  assert.ok(resynced[0]?.kind === 'snapshot')
  assert.equal(resynced[0].projection.thread.title, 'Synthetic handoff-race')
  assert.equal((yield* reads.getThreadProjection(historyThreadId)).visibleTurnItems.length, 360)
  return { replayedEvents: 1, handoffRaceEvents: 1, duplicateEvents: 0,
    futureCursorSnapshots: 1, prunedCursorSnapshots: 1, synchronizedMarkers: 3 }
})
