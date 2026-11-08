import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Effect from 'effect/Effect'
import * as DateTime from 'effect/DateTime'
import * as Schema from 'effect/Schema'
import { SourceContracts as S } from '@nessie/t3-session-source/engine'
import { captureRetainedT3 } from '../../dist/t3-session/import/capture.js'
import { createRetainedCatalogService } from '../../dist/t3-session/catalog/service.js'
import { engineFixture } from '../t3-session-import/engine-fixture.mjs'
import { catalogFixture } from './fixture.mjs'

test('bounded snapshot and original cursors reach all 360 items with generation-bound retry', async () => {
  const f = await catalogFixture({ messages: 360 })
  try {
    const params = { threadId: S.ThreadId.make(f.ids[0]) }
    const first = await Effect.runPromise(f.service.http.threadBoundedSnapshot({ params, query: {} }))
    assert.equal(first.value.hasMoreHistory, true)
    const seen = new Set(first.value.projection.visibleTurnItems.map(row => row.sourceItemId))
    const cursors = new Set()
    let cursor = first.value.historyCursor
    while (cursor) {
      assert.equal(cursors.has(cursor), false)
      cursors.add(cursor)
      assert.ok(cursors.size < 30)
      const input = { params, query: { cursor } }
      const page = await Effect.runPromise(f.service.http.threadHistoryPage(input))
      const retry = await Effect.runPromise(f.service.http.threadHistoryPage(input))
      assert.deepEqual(retry, page)
      assert.equal(page.captureGeneration, first.captureGeneration)
      for (const row of page.value.items) seen.add(row.sourceItemId)
      await Effect.runPromise(Schema.encodeEffect(S.OrchestrationV2ThreadHistoryPage)(page.value))
      cursor = page.value.nextCursor
    }
    assert.equal(seen.size, 360)
    assert.ok(cursors.size > 1)
    await captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
    await assert.rejects(Effect.runPromise(f.service.http.threadHistoryPage({ params,
      query: { cursor: [...cursors][0] } })), /obsolete/u)
  } finally { f.close() }
})

test('fresh legacy catalog reads preserve backdated and tied source message order', async () => {
  const f = await engineFixture({ legacy: true, messages: 4 })
  try {
    for (const [id, at] of [['backdated', '2019-01-01T00:00:00.000Z'], ['aaa:tied', '2020-01-01T00:00:00.000Z']]) {
      f.writer.prepare(`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES (?, ?, 'user', ?, 0, ?, ?)`)
        .run(id, f.ids[0], `ordinary ${id}`, at, at)
    }
    const capture = await captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
    const service = createRetainedCatalogService(f.ports, { manifest: f.manifest, ...f.source, generation: capture.generation })
    const { value } = await Effect.runPromise(service.http.threadSnapshot({
      params: { threadId: S.ThreadId.make(f.ids[0]) }, query: undefined,
    }))
    const expected = f.writer.prepare(`SELECT message_id, created_at FROM projection_thread_messages
      WHERE thread_id = ? ORDER BY created_at, message_id`).all(f.ids[0])
    assert.deepEqual(value.projection.messages.map(row => ({ id: row.id, at: DateTime.formatIso(row.createdAt) })),
      expected.map(row => ({ id: row.message_id, at: row.created_at })))
  } finally { f.close() }
})

test('family doorway recovers idle nested children and keeps orphan identity in full catalog', async () => {
  const f = await engineFixture({ messages: 0 })
  try {
    const template = f.writer.prepare('SELECT * FROM orchestration_v2_projection_threads WHERE thread_id = ?').get(f.ids[0])
    const base = JSON.parse(template.payload_json)
    const columns = Object.keys(template)
    const insert = f.writer.prepare(`INSERT INTO orchestration_v2_projection_threads
      (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    for (const [id, parent, root] of [['child:one', f.ids[0], f.ids[0]],
      ['grandchild:two', 'child:one', f.ids[0]], ['orphan:three', 'absent:parent', 'absent:parent']]) {
      const value = { ...base, id, historyOrigin: 'native', lineage: {
        parentThreadId: parent, relationshipToParent: 'subagent', rootThreadId: root,
      } }
      const row = { ...template, thread_id: id, payload_json: JSON.stringify(value) }
      insert.run(...columns.map(column => row[column]))
    }
    const capture = await captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
    const service = createRetainedCatalogService(f.ports, { manifest: f.manifest, ...f.source, generation: capture.generation })
    const family = await Effect.runPromise(service.rpc['orchestration.getThreadFamily']({ threadId: S.ThreadId.make(f.ids[0]) }))
    assert.deepEqual(new Set(family.value.threads.map(row => row.id)), new Set([f.ids[0], 'child:one', 'grandchild:two']))
    const full = await Effect.runPromise(service.http.shellSnapshot({ params: undefined, query: {} }))
    assert.ok(full.value.threads.some(row => row.id === 'orphan:three'))
    assert.equal(full.value.threads.find(row => row.id === 'orphan:three').lineage.parentThreadId, 'absent:parent')
  } finally { f.close() }
})
