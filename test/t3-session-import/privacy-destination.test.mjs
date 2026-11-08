import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { test } from 'node:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'
import { createSessionStateLayers, createSessionReadLayers, EventStore, ThreadReadService,
  ThreadStream, SourceContracts as S } from '@nessie/t3-session-source/engine'
import { captureRetainedT3, resumeRetainedT3 } from '../../dist/t3-session/import/capture.js'
import { readRetainedProjection } from '../../dist/t3-session/import/reads.js'
import { engineFixture, sqlLayer } from './engine-fixture.mjs'
import { addQuestion, addAnswer, addEvent, assertDestinationsClean, at, canary, ordinary } from './privacy-fixture.mjs'

const capture = f => captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
const resume = (f, generation) => resumeRetainedT3(f.ports, f.manifest, f.source.admittedRootKey, generation)

test('actual capture redacts before SQLite, caches, original replay/export, resume and legacy refresh', async t => {
  const f = await engineFixture({ messages: 4 })
  const logs = []
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    t.mock.method(console, method, (...values) => logs.push(inspect(values)))
  }
  try {
    // Runtime requests precede turn items in the admitted table order; event
    // replay also deliberately encounters a resolved answer before its question.
    const answer = addAnswer(f)
    const question = addQuestion(f)
    const eventIds = [addEvent(f, 'runtime-request.updated', answer), addEvent(f, 'turn-item.updated', question)]
    addAnswer(f, { request: 'request:public', answer: ordinary })
    addQuestion(f, { request: 'request:public', mask: false, answer: ordinary, ordinal: 1001 })
    // Same question ID on a different thread must not inherit the first mask.
    addAnswer(f, { thread: f.ids[1], request: 'request:other', answer: ordinary })
    addQuestion(f, { thread: f.ids[1], request: 'request:other', mask: false, answer: ordinary, ordinal: 1002 })
    const first = await capture(f)
    assert.equal(first.localState, 'ready')
    assert.deepEqual(first.source, f.source)
    assert.deepEqual(first.watermark, { generation: first.generation,
      sequence: f.writer.prepare('SELECT MAX(sequence) AS n FROM orchestration_events').get().n })
    const state = createSessionStateLayers()
    const reads = createSessionReadLayers(state)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* EventStore.EventStoreV2
      const service = yield* ThreadReadService
      const replay = yield* store.read({ threadId: S.ThreadId.make(f.ids[0]) }).pipe(Stream.runCollect)
      assert.deepEqual(replay.filter(row => eventIds.includes(row.id)).map(row => row.id), eventIds)
      assert.equal(JSON.stringify(replay).includes(canary), false)
      // Twice through the same original service instance exercises its caches.
      for (let pass = 0; pass < 2; pass++) {
        const full = yield* service.getThreadProjection(S.ThreadId.make(f.ids[0]))
        assert.equal(JSON.stringify(full).includes(canary), false)
        assert.ok(JSON.stringify(full).includes(ordinary))
        const snapshot = yield* service.getThreadSnapshotWindow(S.ThreadId.make(f.ids[0]), { rowLimit: 25 })
        const wire = ThreadStream.buildBoundedThreadStreamSnapshot({ ...snapshot,
          compactTurnItems: true, dedupeBodies: true, compactIds: true })
        assert.equal(JSON.stringify(wire).includes(canary), false)
      }
    }).pipe(Effect.provide(reads.layer.pipe(Layer.provideMerge(sqlLayer(f.destination(first.generation))))))))
    await resume(f, first.generation)
    // A later answer and fresh legacy history must be classified again on refresh.
    addQuestion(f, { request: 'request:late', ordinal: 1003 })
    addAnswer(f, { request: 'request:late' })
    f.writer.prepare(`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES (?, ?, 'user', ?, 0, ?, ?)`)
      .run('legacy:after', f.ids[0], ordinary, at, at)
    const next = await capture(f)
    assert.notEqual(next.generation, first.generation)
    const full = await readRetainedProjection(f.ports, f.manifest, f.source.admittedRootKey,
      next.generation, S.ThreadId.make(f.ids[0]))
    assert.deepEqual(full.messages.filter(message => message.id !== 'legacy:after').map(message => message.text),
      Array.from({ length: 4 }, (_, index) => `ordinary transcript ${index} 雪`))
    assert.equal(full.messages.find(message => message.id === 'legacy:after').text, ordinary)
    assert.equal(JSON.stringify(full).includes(canary), false)
    assertDestinationsClean(f)
    assert.equal(logs.join('\n').includes(canary), false)
  } finally { f.close() }
})

for (const scenario of ['missing', 'unknown', 'conflict', 'orphan-answer', 'capacity']) {
  test(`actual capture rejects ${scenario} before session inserts, retaining prior catalog`, async t => {
    const f = await engineFixture({ messages: 4 })
    const logs = []
    for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...values) => logs.push(inspect(values)))
    try {
      const first = await capture(f)
      if (scenario === 'orphan-answer') addAnswer(f)
      else if (scenario === 'capacity') {
        for (let index = 0; index < 8193; index++) addQuestion(f, { request: `request:${index}`, ordinal: 1000 + index })
      } else {
        const value = addQuestion(f, { mask: scenario === 'unknown' ? 'unknown' : true })
        if (scenario === 'missing') {
          delete value.questions[0].isSecret
          f.writer.prepare('UPDATE orchestration_v2_projection_turn_items SET payload_json = ? WHERE turn_item_id = ?')
            .run(JSON.stringify(value), value.id)
        }
        if (scenario === 'conflict') {
          addQuestion(f, { id: 'item:conflict', mask: false, ordinal: 1001, answer: ordinary })
        }
        addAnswer(f)
      }
      let failure
      try { await capture(f) } catch (error) { failure = error }
      assert.ok(failure)
      assert.match(failure.message, /capture_(question_classification|privacy_incomplete)/u)
      assert.equal(inspect(failure).includes(canary), false)
      const root = f.ports.journal.root(f.source.physicalRootKey)
      assert.equal(root.last_ready_generation, first.generation)
      assert.notEqual(root.generation, first.generation)
      // A stage is allowed to remain unopened when privacy preflight fails.
      assertDestinationsClean(f)
      assert.equal(logs.join('\n').includes(canary), false)
    } finally { f.close() }
  })
}
