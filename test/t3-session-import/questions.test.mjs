import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareTinySources } from './tiny-source.mjs'

const tiny = await prepareTinySources()
const { CaptureQuestions } = await tiny.load('import/questions')
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

test('missing classification, unsupported marker, conflicting reuse and absent request fail explicitly', () => {
  for (const row of [question('unknown', undefined), answer('unknown')]) {
    const privacy = new CaptureQuestions()
    privacy.transform(row, 'thread')
    assert.throws(() => privacy.complete(), /classification_unknown/u)
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
  assert.throws(() => privacy.transform(answer('different'), 'thread', marker), /classification_unknown/u)
  const bounded = new CaptureQuestions()
  assert.throws(() => {
    for (let index = 0; index < 8193; index++) bounded.transform(question(String(index), true), 't')
  }, /privacy_incomplete/u)
  assert.throws(() => new CaptureQuestions().transform(question('x'.repeat(1025), true), 't'), /privacy_incomplete/u)
})
