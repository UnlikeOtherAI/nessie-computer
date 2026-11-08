import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Schema from 'effect/Schema'
import { SourceContracts as S } from '@nessie/t3-session-source/engine'
import { captureRetainedT3 } from '../../dist/t3-session/import/capture.js'
import { readRetainedProjection } from '../../dist/t3-session/import/reads.js'
import { UNKNOWN_QUESTION_VALUE } from '../../dist/t3-session/import/questions.js'
import { engineFixture } from './engine-fixture.mjs'
import { addQuestion, addAnswer, addEvent, assertDestinationsClean, assertGenerationEmpty,
  canary, ordinary } from './privacy-fixture.mjs'

const encode = (schema, value) => Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(value))
const saveItem = (f, item) => f.writer.prepare(
  'UPDATE orchestration_v2_projection_turn_items SET payload_json = ? WHERE turn_item_id = ?',
).run(JSON.stringify(item), item.id)

test('original codec history retains exact catalog/order and withholds question copies and attachment previews', async () => {
  const f = await engineFixture({ messages: 4 })
  try {
    const request = 'request:unknown'
    const answer = addAnswer(f, { request })
    const item = addQuestion(f, { request, codecStored: true })
    item.responseMode = 'message'
    item.providerThreadId = 'provider-thread:historical'
    item.providerTurnId = 'provider-turn:historical'
    item.nativeItemRef = { driver: 'claude', nativeId: 'call:historical', strength: 'strong' }
    item.title = 'Original question title'
    item.questions[0].header = 'Original header'
    item.questions[0].question = 'Original question text'
    item.questions[0].options[0].label = 'Original option label'
    item.questions[0].options[0].description = 'Original option description'
    // The original schema permits duplicate IDs; answer maps have no ordinal.
    // With no masks both occurrences are preserved and explicitly withheld.
    item.questions.push(structuredClone(item.questions[0]))
    item.questionAnswer.questionTextById = { 'q:reused': item.questions[0].question }
    item.questionAnswer.attachmentsByQuestionId = { 'q:reused': [
      { type: 'file', id: 'historical_file', name: canary, mimeType: canary, sizeBytes: 17 },
      { type: 'image', id: 'historical_image', name: canary, mimeType: 'image/png', sizeBytes: 19,
        source: { kind: 'snap-shot', capturedAt: '2020-01-01T00:00:00.000Z', appName: canary,
          windowTitle: canary, accessibleText: canary } },
    ] }
    saveItem(f, encode(S.OrchestrationV2TurnItemJson, item))
    // Event order is deliberately opposite to the association's direction.
    addEvent(f, 'runtime-request.updated', encode(S.OrchestrationV2RuntimeRequestJson, answer))
    addEvent(f, 'turn-item.updated', encode(S.OrchestrationV2TurnItemJson, item))

    const row = f.writer.prepare('SELECT * FROM orchestration_v2_projection_messages WHERE role = ? LIMIT 1').get('user')
    const original = JSON.parse(row.payload_json)
    const message = encode(S.OrchestrationV2ConversationMessageJson,
      { ...original, id: `async-answer:${request}`, text: canary })
    f.writer.prepare(`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(message.id, row.thread_id, row.run_id, row.node_id,
        row.role, row.streaming, row.created_at, row.updated_at, JSON.stringify(message))
    addEvent(f, 'message.updated', message)

    const template = JSON.parse(f.writer.prepare(
      "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE type = 'user_message' LIMIT 1",
    ).get().payload_json)
    for (const copy of [
      { ...template, id: 'item:async-copy', ordinal: 1005, messageId: message.id, text: canary },
      { ...item, id: 'item:tool-copy', ordinal: 1006, type: 'dynamic_tool', toolName: 'AskUserQuestion',
        input: { questions: item.questions }, output: { answers: { 'q:reused': canary } } },
      { ...template, id: 'item:attachment-copy', ordinal: 1007, text: ordinary,
        attachments: item.questionAnswer.attachmentsByQuestionId['q:reused'],
        context: { version: 1, records: [{ version: 1, contextId: 'context_file', kind: 'file',
          attachmentId: 'historical_file', label: canary, name: canary, mimeType: canary, sizeBytes: 17 }] } },
    ]) {
      const encoded = encode(S.OrchestrationV2TurnItemJson, copy)
      f.writer.prepare(`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(encoded.id, encoded.threadId, encoded.ordinal, encoded.type, encoded.status,
          encoded.updatedAt, JSON.stringify(encoded))
      addEvent(f, 'turn-item.updated', encoded)
    }
    addQuestion(f, { request: 'request:public', mask: false, answer: ordinary, ordinal: 1008 })
    addAnswer(f, { request: 'request:public', answer: ordinary })
    const beforeIds = f.writer.prepare('SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id').all()
    const beforeOrder = f.writer.prepare(
      'SELECT turn_item_id, ordinal FROM orchestration_v2_projection_turn_items WHERE thread_id = ? ORDER BY ordinal',
    ).all(f.ids[0])
    const receipt = await captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
    const full = await readRetainedProjection(f.ports, f.manifest, f.source.admittedRootKey,
      receipt.generation, S.ThreadId.make(f.ids[0]))
    assert.equal(JSON.stringify(full).includes(canary), false)
    assert.ok(JSON.stringify(full).includes(ordinary))
    assert.equal(full.messages.find(value => value.id === message.id).text, UNKNOWN_QUESTION_VALUE)
    assert.deepEqual(full.turnItems.map(value => ({ turn_item_id: value.id, ordinal: value.ordinal })),
      beforeOrder.map(value => ({ ...value })))
    const captured = full.turnItems.find(value => value.id === item.id)
    assert.equal(captured.title, item.title)
    assert.equal(captured.questions[0].header, item.questions[0].header)
    assert.equal(captured.questions[0].question, item.questions[0].question)
    assert.equal(captured.questions[0].options[0].label, item.questions[0].options[0].label)
    assert.equal(captured.questions[0].options[0].description, item.questions[0].options[0].description)
    assert.equal(captured.questions[0].options[0].value, UNKNOWN_QUESTION_VALUE)
    assert.equal(captured.questions[0].options[0].preview, UNKNOWN_QUESTION_VALUE)
    assert.deepEqual(captured.questionAnswer.questionTextById, item.questionAnswer.questionTextById)
    assert.deepEqual(captured.questions.map(value => value.id), ['q:reused', 'q:reused'])
    assert.deepEqual(captured.questionAnswer.attachmentsByQuestionId['q:reused'].map(value =>
      [value.id, value.type, value.sizeBytes]), [['historical_file', 'file', 17], ['historical_image', 'image', 19]])
    // Compare every identity, including archived/deleted/empty and Unicode IDs.
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(f.destination(receipt.generation), { readOnly: true })
    try {
      assert.deepEqual(database.prepare('SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id').all(),
        beforeIds)
    } finally { database.close() }
    assertDestinationsClean(f)
  } finally { f.close() }
})

test('exact observed request redacts its legacy message copy before original hydration and replay', async () => {
  const request = 'request:legacy'
  const messageId = `async-answer:${request}`
  const f = await engineFixture({ messages: 4, firstMessageId: messageId, firstMessageText: canary })
  try {
    const question = addQuestion(f, { request, codecStored: true })
    question.responseMode = 'message'
    saveItem(f, encode(S.OrchestrationV2TurnItemJson, question))
    addAnswer(f, { request })
    const receipt = await captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
    const full = await readRetainedProjection(f.ports, f.manifest, f.source.admittedRootKey,
      receipt.generation, S.ThreadId.make(f.ids[0]))
    assert.equal(full.messages.find(value => value.id === messageId).text, UNKNOWN_QUESTION_VALUE)
    assert.equal(full.messages.length, 4)
    assertDestinationsClean(f)
  } finally { f.close() }
})

for (const mismatch of ['thread', 'request', 'item']) {
  test(`original valid codec with inconsistent ${mismatch} identity refuses before capture inserts`, async () => {
    const f = await engineFixture({ messages: 4 })
    try {
      const question = addQuestion(f, { codecStored: true })
      const originalId = question.id
      if (mismatch === 'thread') question.threadId = f.ids[1]
      if (mismatch === 'request') question.questionAnswer.requestId = 'request:other'
      if (mismatch === 'item') question.id = 'item:other'
      f.writer.prepare('UPDATE orchestration_v2_projection_turn_items SET payload_json = ? WHERE turn_item_id = ?')
        .run(JSON.stringify(encode(S.OrchestrationV2TurnItemJson, question)), originalId)
      await assert.rejects(captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey),
        /capture_question_provenance_conflict/u)
      const root = f.ports.journal.root(f.source.physicalRootKey)
      assertGenerationEmpty(f, root.generation)
      assertDestinationsClean(f)
    } finally { f.close() }
  })
}

test('original Claude textual question identity stays exact; only value concealment is claimed', async () => {
  const f = await engineFixture({ messages: 4 })
  try {
    const identity = 'Synthetic question used as original identity'
    const item = addQuestion(f, { codecStored: true })
    item.questions[0].id = identity
    item.questions[0].question = identity
    item.questionAnswer.answers = { [identity]: [canary] }
    item.questionAnswer.questionTextById = { [identity]: identity }
    item.questionAnswer.attachmentsByQuestionId = {}
    saveItem(f, encode(S.OrchestrationV2TurnItemJson, item))
    const receipt = await captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
    const full = await readRetainedProjection(f.ports, f.manifest, f.source.admittedRootKey,
      receipt.generation, S.ThreadId.make(f.ids[0]))
    const captured = full.turnItems.find(value => value.id === item.id)
    assert.equal(captured.questions[0].id, identity)
    assert.equal(captured.questions[0].question, identity)
    assert.equal(captured.questions[0].header, item.questions[0].header)
    assert.equal(captured.questions[0].options[0].label, item.questions[0].options[0].label)
    assert.equal(captured.questions[0].options[0].description, item.questions[0].options[0].description)
    assert.equal(captured.questions[0].initialAnswer, UNKNOWN_QUESTION_VALUE)
    assert.equal(captured.questions[0].options[0].value, UNKNOWN_QUESTION_VALUE)
    assert.equal(captured.questions[0].options[0].preview, UNKNOWN_QUESTION_VALUE)
    assert.deepEqual(Object.keys(captured.questionAnswer.answers), [identity])
    assert.deepEqual(captured.questionAnswer.answers[identity], [UNKNOWN_QUESTION_VALUE])
    assert.deepEqual(captured.questionAnswer.questionTextById, { [identity]: identity })
    // This is an intentional identity disclosure, not secret-free identity proof.
    assert.ok(JSON.stringify(captured).includes(identity))
    assertDestinationsClean(f)
  } finally { f.close() }
})
