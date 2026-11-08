import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTypeScriptTypes } from 'node:module'
import { readRequestSource } from './source-fixture.mjs'

const load = async () => {
  const { snapshot } = await readRequestSource()
  const source = stripTypeScriptTypes(snapshot.read('packages/client-runtime/src/state/pendingUserInput.ts').toString())
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

test('original helper preserves exact custom strings, opaque choices and optional omission', async () => {
  const { buildPendingUserInputAnswers: build } = await load()
  const questions = [{ id: '__proto__', options: [] }, { id: 'optional', options: [], required: false }]
  const drafts = Object.fromEntries([['__proto__', { customAnswer: '  čau\r\nnope pls  ' }]])
  assert.deepEqual(build(questions, drafts), Object.fromEntries([['__proto__', '  čau\r\nnope pls  ']]))
  assert.equal(build(questions, {}), null)
  assert.deepEqual(build([{ id: 'q', options: [], required: false }], { q: { customAnswer: '' } }), { q: '' })
  assert.deepEqual(build([{ id: 'q', options: [], initialAnswer: 'before' }], { q: { customAnswer: '' } }), { q: '' })
  const choice = { id: 'q', multiSelect: true, options: [
    { label: 'Same', value: '' }, { label: 'Same', value: '  exact  ' },
  ] }
  assert.deepEqual(build([choice], { q: { selectedOptionValues: ['', '  exact  '] } }), { q: ['', '  exact  '] })
  assert.equal(build([questions[0], questions[0]], drafts), null)
})

test('original helper distinguishes attachment-only answers from unanswered questions', async () => {
  const { buildPendingUserInputAnswers: build } = await load()
  const questions = [{ id: 'q', options: [] }]
  assert.deepEqual(build(questions, { q: { attachmentCount: 1 } }), { q: '' })
  assert.equal(build(questions, { q: { attachmentCount: 1, attachmentsBlocked: true } }), null)
})
