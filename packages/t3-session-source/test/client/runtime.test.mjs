import assert from 'node:assert/strict'
import test from 'node:test'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Contracts from '@nessie/t3-session-source/contracts'
import { SourceContracts, ThreadHistoryController, buildThreadListV2Items,
  buildThreadListV2ListItems, buildArchivedThreadGroups } from '@nessie/t3-session-source/client'
import { archived, now, thread } from './fixture.mjs'

test('client retains original codec identity and history controller registration lifetime', async () => {
  assert.equal(SourceContracts.ThreadId, Contracts.ThreadId)
  const environmentId = Contracts.EnvironmentId.make('machine-a')
  const threadId = Contracts.ThreadId.make('same-original-id')
  const result = await Effect.runPromise(Effect.gen(function* () {
    const controller = yield* ThreadHistoryController.ThreadHistoryController
    const first = yield* controller.register(environmentId, threadId, {
      loadEarlier: () => Effect.succeed({ _tag: 'error', message: 'obsolete handler' }),
      reconcilePendingWork: () => Effect.void,
    })
    const replacement = yield* controller.register(environmentId, threadId, {
      loadEarlier: () => Effect.succeed({ _tag: 'loaded' }), reconcilePendingWork: () => Effect.void,
    })
    yield* controller.unregister(first)
    const loaded = yield* controller.loadEarlier(environmentId, threadId)
    yield* controller.unregister(replacement)
    return [loaded, yield* controller.loadEarlier(environmentId, threadId)]
  }).pipe(Effect.provide(ThreadHistoryController.layer)))
  assert.deepEqual(result, [{ _tag: 'loaded' }, { _tag: 'noop' }])
})

test('original mobile selectors retain environment identity, shelves, membership and order', () => {
  const pinned = thread('machine-a', 'pinned', { pinnedAt: now })
  const active = thread('machine-a', 'same-original-id')
  const otherMachine = thread('machine-b', 'same-original-id')
  const settled = thread('machine-a', 'settled', { settledOverride: 'settled', settledAt: now })
  const hidden = thread('machine-a', 'archived', { archivedAt: now })
  const layout = buildThreadListV2Items({ threads: [settled, hidden, active, pinned, otherMachine],
    environmentId: Contracts.EnvironmentId.make('machine-a'), searchQuery: '', now })
  assert.deepEqual(layout.items.map(item => item.thread), [pinned, active, settled])
  assert.deepEqual(layout.items.map(item => item.variant), ['card', 'card', 'slim'])
  assert.equal(layout.settledCount, 1)
  const rows = buildThreadListV2ListItems({ ...layout, pendingTasks: [], snoozeLabelNow: now })
  assert.deepEqual(rows.map(row => row.key), ['v2-thread:machine-a:pinned',
    'v2-thread:machine-a:same-original-id', 'v2-settled-shelf', 'v2-thread:machine-a:settled'])
  const all = buildThreadListV2Items({ threads: [active, otherMachine], environmentId: null,
    searchQuery: '', now })
  assert.deepEqual(new Set(all.items.map(item => `${item.thread.environmentId}:${item.thread.id}`)),
    new Set(['machine-a:same-original-id', 'machine-b:same-original-id']))
})

test('original archive selector keeps per-machine project groups and archive order', () => {
  const project = { id: Contracts.ProjectId.make('project-a'), title: 'Fixture project',
    workspaceRoot: '/synthetic/project', createdAt: DateTime.makeUnsafe(now),
    updatedAt: DateTime.makeUnsafe(now), deletedAt: null }
  const snapshots = ['machine-a', 'machine-b'].map(environment => ({
    environmentId: Contracts.EnvironmentId.make(environment), snapshot: {
      projects: [project], threads: [archived('older', '2026-11-01T00:00:00Z'),
        archived('newer', '2026-11-07T00:00:00Z')],
    },
  }))
  const input = { snapshots, environmentLabels: {}, environmentId: null, searchQuery: '', sortOrder: 'newest' }
  const groups = buildArchivedThreadGroups(input)
  assert.deepEqual(groups.map(group => group.key), ['machine-a:project-a', 'machine-b:project-a'])
  assert.deepEqual(groups.map(group => group.threads.map(thread => thread.id)),
    [['newer', 'older'], ['newer', 'older']])
  const selected = buildArchivedThreadGroups({ ...input, environmentId: Contracts.EnvironmentId.make('machine-b'),
    sortOrder: 'oldest' })
  assert.deepEqual(selected.map(group => group.key), ['machine-b:project-a'])
  assert.deepEqual(selected[0].threads.map(thread => thread.id), ['older', 'newer'])
})
