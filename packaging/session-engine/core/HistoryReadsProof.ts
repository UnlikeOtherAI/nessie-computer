import assert from 'node:assert/strict'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import { OrchestrationV2ThreadProjection, OrchestrationV2ThreadStreamItem,
  ThreadId } from 't3-source:packages/contracts/src/index.ts'
import { ApplicationEvents, ProjectStore } from './StateLayers.ts'
import { ShellStream, ThreadReadService, ThreadStream, WireProjection } from './ReadLayers.ts'
import { historyMessageCount, historyProjectId, historyThreadCount, historyThreadId } from './HistoryFixture.ts'

/** Exercises original services and codecs. No receipt or projection reducer is reimplemented. */
export const qualifyRetainedReads = Effect.gen(function* () {
  const reads = yield* ThreadReadService
  const sql = yield* SqlClient.SqlClient
  const projects = yield* ProjectStore.ProjectStoreV2
  const applicationEvents = yield* ApplicationEvents.OrchestrationEventStore
  assert.equal(yield* reads.countThreads(), historyThreadCount + 2)
  const listed = yield* reads.listProjectThreads({ projectId: historyProjectId, includeSubagents: true })
  assert.ok(listed.length > 100)
  assert.equal((yield* reads.getShellSnapshot({ location: 'archive' })).archivedThreads.length, 10)
  const full = yield* reads.getThreadSnapshot(historyThreadId)
  assert.equal(full.projection.messages.length, historyMessageCount)
  assert.equal(full.projection.visibleTurnItems.length, historyMessageCount)
  const encoded = yield* Schema.encodeEffect(OrchestrationV2ThreadProjection)(
    WireProjection.projectThreadProjectionForWire(full.projection),
  )
  assert.equal((yield* Schema.decodeUnknownEffect(OrchestrationV2ThreadProjection)(encoded))
    .visibleTurnItems[0]?.sourceItemId, full.projection.visibleTurnItems[0]?.sourceItemId)

  const window = yield* reads.getThreadSnapshotWindow(historyThreadId, { rowLimit: 25 })
  const bounded = ThreadStream.buildBoundedThreadStreamSnapshot({ ...window,
    compactTurnItems: true, dedupeBodies: true, compactIds: true })
  yield* Schema.encodeEffect(OrchestrationV2ThreadStreamItem)(bounded)
  assert.equal(bounded.hasMoreHistory, true)
  const ids = new Set(window.projection.visibleTurnItems.map(item => item.sourceItemId))
  const cursors = new Set<string>()
  let cursor = bounded.historyCursor
  let pages = 0
  while (cursor) {
    assert.equal(cursors.has(cursor), false, 'History cursor must advance.')
    cursors.add(cursor)
    const page = yield* reads.getThreadHistoryPage(historyThreadId, cursor)
    for (const item of page.items) ids.add(item.sourceItemId)
    cursor = page.nextCursor
    pages++
    assert.ok(pages <= historyMessageCount)
  }
  assert.equal(ids.size, historyMessageCount)
  assert.ok(pages > 1)
  const find = yield* reads.searchThread({ threadId: historyThreadId, query: 'Dávná zpráva' })
  assert.equal(find.totalMatches, 1)
  assert.equal(find.match?.entryId, 'history:message:0')
  const transcript = yield* reads.getThreadTranscript(historyThreadId)
  assert.equal(transcript.items.length, historyMessageCount)

  const inherited = yield* reads.getThreadSnapshot(ThreadId.make('history:fork'))
  const inheritedIds = new Set(inherited.projection.visibleTurnItems.map(item => item.sourceItemId))
  assert.equal(inheritedIds.size, historyMessageCount)
  assert.ok(inherited.projection.visibleTurnItems.every(item => item.sourceThreadId === historyThreadId))
  const decodeFamily = yield* reads.readShellSnapshot({ familyOf: historyThreadId })
  const family = yield* decodeFamily
  assert.deepEqual(new Set(family.threads.map(thread => thread.id)),
    new Set([historyThreadId, 'history:fork', 'history:child']))
  const shell = yield* ShellStream.loadSubscriberShellSnapshot({ sql,
    listShellIndex: reads.listActiveShellIndex(),
    readThreads: threadIds => reads.readShellSnapshot({ location: 'active',
      ...(threadIds === undefined ? {} : { threadIds }) }),
    listProjects: projects.listShells(), latestSequence: applicationEvents.latestApplicationSequence,
    options: { omitOlderSettled: true, omitIdleSubagents: true } })
  assert.equal(shell.snapshot.projects.length, 1)
  assert.ok(shell.snapshot.olderSettled)
  const olderIds = new Set<string>()
  let before: { settledAt: string; threadId?: ThreadId } = { settledAt: '2026-01-01T00:00:00.000Z' }
  while (true) {
    const page = yield* ShellStream.loadOlderSettledThreadsPage({ sql,
      listThreads: reads.listOlderSettledThreads({ before: {
        settledAt: before.settledAt, ...(before.threadId === undefined ? {} : { threadId: before.threadId }),
      }, limit: 17 }),
      readThreads: threadIds => reads.readShellSnapshot({ location: 'active', threadIds }),
      latestSequence: applicationEvents.latestApplicationSequence })
    if (!page.threads.length) break
    for (const thread of page.threads) {
      assert.equal(olderIds.has(thread.id), false)
      olderIds.add(thread.id)
    }
    const last = page.threads.at(-1)!
    assert.ok(last.settledAt)
    // The cursor is the source codec's encoded timestamp, not an executor-specific DTO.
    before = { settledAt: DateTime.formatIso(last.settledAt), threadId: last.id }
    assert.ok(olderIds.size <= 60)
  }
  assert.equal(olderIds.size, 60)
  return { catalogThreads: historyThreadCount + 2, archivedThreads: 10,
    olderSettledThreads: olderIds.size, historyRows: ids.size, historyPages: pages,
    inheritedRows: inheritedIds.size, familyMembers: family.threads.length, markdownMatches: find.totalMatches }
})
