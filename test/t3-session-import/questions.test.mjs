import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareTinySources } from './tiny-source.mjs'

const tiny = await prepareTinySources()
const { CaptureQuestions, UNKNOWN_QUESTION_VALUE } = await tiny.load('import/questions')
const question = (requestId, isSecret) => ({ type: 'user_input_request', requestId,
  questions: [{ id: 'same', isSecret, initialAnswer: 'synthetic' }] })
const answer = id => ({ kind: 'user_input', id, answers: { same: ['synthetic'] } })
// These tests qualify metadata association only. The actual shared projector,
// original codecs and SQLite sinks are exercised by privacy-destination.test.
const marker = value => ({ ...value, initialAnswer: '[REDACTED]' })

for (const reversed of [false, true]) {
  test(`metadata association preserves request/thread identity, reverse=${reversed}`, () => {
    const privacy = new CaptureQuestions()
    const rows = [answer('secret'), question('secret', true), answer('public'), question('public', false)]
    for (const row of reversed ? rows.toReversed() : rows) privacy.transform(row, 'thread:one')
    privacy.transform(question('secret', false), 'thread:two')
    privacy.transform(answer('secret'), 'thread:two')
    privacy.complete()
    assert.deepEqual(privacy.transform(answer('secret'), 'thread:one', marker).answers.same, ['[REDACTED]'])
    assert.deepEqual(privacy.transform(answer('public'), 'thread:one', marker), answer('public'))
    assert.deepEqual(privacy.transform(answer('secret'), 'thread:two', marker), answer('secret'))
    assert.equal(privacy.transform(question('secret', true), 'thread:one', marker).questions[0].initialAnswer, '[REDACTED]')
    assert.equal(JSON.stringify(privacy).includes('synthetic'), false)
  })
}

test('unknown classification is withheld; orphan, malformed and conflicting provenance still refuse', () => {
  const unknown = new CaptureQuestions()
  unknown.transform(answer('unknown'), 'thread')
  unknown.transform(question('unknown', undefined), 'thread')
  unknown.complete()
  assert.deepEqual(unknown.transform(answer('unknown'), 'thread', marker).answers.same, [UNKNOWN_QUESTION_VALUE])
  assert.equal(unknown.transform(question('unknown', undefined), 'thread', marker).questions[0].initialAnswer,
    UNKNOWN_QUESTION_VALUE)
  for (const row of [answer('unknown')]) {
    const privacy = new CaptureQuestions()
    privacy.transform(row, 'thread')
    assert.throws(() => privacy.complete(), /provenance_unknown/u)
  }
  const privacy = new CaptureQuestions()
  assert.throws(() => privacy.transform(question('unknown', 'false'), 'thread'), /classification_unknown/u)
  privacy.transform(question('repeat', true), 'thread')
  assert.throws(() => privacy.transform(question('repeat', false), 'thread'), /classification_conflict/u)
  assert.throws(() => privacy.transform(question(undefined, true), 'thread'), /provenance_unknown/u)
})

test('ordinary tool JSON cannot supply or borrow original question provenance', () => {
  const privacy = new CaptureQuestions()
  const tool = { type: 'dynamic_tool', input: { requestId: 'ordinary', answers: { same: ['ordinary'] },
    nested: question('secret', false) } }
  assert.deepEqual(privacy.transform(tool, 'thread'), tool)
  privacy.complete()
  assert.deepEqual(privacy.transform(tool, 'thread', marker), tool)
})

test('a classified occurrence covers codec-stripped copies, never another request; bounds do not evict', () => {
  const privacy = new CaptureQuestions()
  privacy.transform(question('request', undefined), 'thread')
  privacy.transform(question('request', true), 'thread')
  privacy.complete()
  assert.equal(privacy.transform(question('request', undefined), 'thread', marker).questions[0].initialAnswer, '[REDACTED]')
  assert.throws(() => privacy.transform(answer('different'), 'thread', marker), /provenance_unknown/u)
  const bounded = new CaptureQuestions()
  assert.throws(() => {
    for (let index = 0; index < 8193; index++) bounded.transform(question(String(index), true), 't')
  }, /privacy_incomplete/u)
  assert.throws(() => new CaptureQuestions().transform(question('x'.repeat(1025), true), 't'), /privacy_incomplete/u)
})

test('unknown answers preserve array positions, arbitrary keys and exact public shapes', () => {
  const privacy = new CaptureQuestions()
  const item = question('unknown', undefined)
  item.questions.push({ id: '__proto__', options: [] })
  const response = { ...answer('unknown'), answers: { same: ['first', 'second'], ['__proto__']: { nested: 'value' } } }
  privacy.transform(response, 'thread')
  privacy.transform(item, 'thread')
  privacy.complete()
  const projected = privacy.transform(response, 'thread', marker)
  assert.deepEqual(projected.answers.same, [UNKNOWN_QUESTION_VALUE, UNKNOWN_QUESTION_VALUE])
  assert.equal(projected.answers.__proto__, UNKNOWN_QUESTION_VALUE)
  assert.deepEqual(Object.keys(projected.answers), ['same', '__proto__'])
})

test('native copies require the same thread, provider thread, turn and driver; conflicting request binding refuses', () => {
  const privacy = new CaptureQuestions()
  const binding = { providerThreadId: 'pt', providerTurnId: 'turn',
    nativeItemRef: { driver: 'claude', nativeId: 'native', strength: 'strong' } }
  privacy.transform({ ...question('unknown', undefined), ...binding, responseMode: 'message' }, 'thread')
  privacy.complete()
  const tool = { type: 'dynamic_tool', ...binding, input: 'synthetic', output: 'synthetic' }
  assert.equal(privacy.transform(tool, 'thread', marker).input, UNKNOWN_QUESTION_VALUE)
  for (const other of [{ ...tool, providerTurnId: 'other' }, { ...tool, providerThreadId: 'other' }]) {
    assert.deepEqual(privacy.transform(other, 'thread', marker), other)
  }
  assert.deepEqual(privacy.transform(tool, 'other-thread', marker), tool)
  assert.throws(() => privacy.transform({ ...question('other', false), ...binding }, 'thread'), /provenance_conflict/u)
  assert.throws(() => new CaptureQuestions().transform({ ...question('a', undefined),
    questionAnswer: { requestId: 'b', answers: { same: ['synthetic'] } } }, 'thread'), /provenance_conflict/u)
})

test('attachment references redact every scoped descriptor and refuse conflicting public reuse', () => {
  const privacy = new CaptureQuestions()
  const attachment = { type: 'image', id: 'opaque_id', name: 'synthetic', mimeType: 'image/png', sizeBytes: 7,
    source: { preview: 'synthetic' } }
  const item = { ...question('a', undefined), questionAnswer: { requestId: 'a',
    attachmentsByQuestionId: { same: [attachment] }, answers: {} } }
  privacy.transform(item, 'thread')
  privacy.complete()
  assert.deepEqual(privacy.projectAttachments([attachment], 'thread'), [{ type: 'image', id: 'opaque_id',
    name: UNKNOWN_QUESTION_VALUE, mimeType: 'image/x-withheld', sizeBytes: 7 }])
  assert.deepEqual(privacy.projectAttachments([attachment], 'other-thread'), [attachment])
  privacy.transform({ ...question('b', false), questionAnswer: { requestId: 'b',
    attachmentsByQuestionId: { same: [attachment] }, answers: {} } }, 'thread')
  assert.throws(() => privacy.complete(), /attachment_classification_conflict/u)
})
