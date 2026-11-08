import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import { createSourceModuleLoader } from '../t3-session-client-connection/module-loader.mjs'
import { readRequestSource, scratch } from './source-fixture.mjs'

const { snapshot } = await readRequestSource()
const loader = createSourceModuleLoader(snapshot, { dependencyDirectory: resolve(scratch, 'dependencies') })
const Schema = await loader.external('effect/Schema')
const S = await loader.load('packages/contracts/src/orchestrationV2.ts')
const source = stripTypeScriptTypes(readFileSync(new URL('../../src/t3-session/requests/validate.ts', import.meta.url),
  'utf8'), { mode: 'transform' })
const { validateT3RuntimeAnswer: validate } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const time = '2026-01-01T00:00:00.000Z'
const base = { id: 'item:opaque', threadId: 'thread:opaque/雪', runId: null, nodeId: 'node:original',
  providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
  ordinal: 0, status: 'pending', title: null, startedAt: null, completedAt: null, updatedAt: time }
const request = Schema.decodeUnknownSync(S.OrchestrationV2RuntimeRequest)({
  id: 'request:original', nodeId: base.nodeId, providerTurnId: null, nativeRequestRef: null,
  kind: 'user_input', status: 'pending', responseCapability: { type: 'live', providerSessionId: 'provider:current' },
  createdAt: time, resolvedAt: null,
})
const question = { id: '__proto__', header: 'Choose', question: 'Kterou možnost?', multiSelect: true,
  allowCustomAnswer: false, options: [{ label: 'Same', description: 'One', value: '' },
    { label: 'Same', description: 'Two', value: '  opaque  ' }] }
const item = Schema.decodeUnknownSync(S.OrchestrationV2TurnItem)({ ...base,
  type: 'user_input_request', requestId: request.id, questions: [question,
    { id: 'optional', header: 'Note', question: 'Any note?', required: false, options: [] }],
})
const command = answers => Schema.decodeUnknownSync(S.OrchestrationV2Command)({
  type: 'runtime-request.respond', commandId: 'command:original', threadId: base.threadId,
  requestId: request.id, answers,
})
const input = answers => ({ command: command(answers), item, request, activeProviderSessionId: 'provider:current' })

test('original-codec request validation preserves empty/multiple choice values and optional omission', () => {
  const value = Object.fromEntries([['__proto__', ['', '  opaque  ']]])
  const current = input(value)
  assert.doesNotThrow(() => validate(current))
  assert.deepEqual(current.command.answers, value)
  for (const answer of [['Same'], ['', ''], ['unknown'], 3, false, null]) {
    assert.throws(() => validate(input(Object.fromEntries([['__proto__', answer]]))), /answer_invalid/)
  }
  assert.throws(() => validate(input({})), /answer_invalid/)
  assert.throws(() => validate(input({ ...value, unexpected: 'yep' })), /answer_invalid/)
})

test('validation refuses stale, settled, mismatched and non-resumable native callbacks', () => {
  const current = input(Object.fromEntries([['__proto__', ['']]]))
  assert.throws(() => validate({ ...current, activeProviderSessionId: 'provider:old' }), /provider_session_stale/)
  for (const status of ['resolved', 'expired', 'cancelled']) {
    assert.throws(() => validate({ ...current, request: { ...request, status } }), /request_not_pending/)
  }
  assert.throws(() => validate({ ...current, item: { ...item, threadId: 'other' } }), /request_mismatch/)
  assert.throws(() => validate({ ...current, request: { ...request,
    responseCapability: { type: 'not_resumable', reason: 'stopped' } } }), /request_not_resumable/)
})

test('approval accepts only explicit original decisions; feedback support and question payloads stay separate', () => {
  const approval = Schema.decodeUnknownSync(S.OrchestrationV2TurnItem)({ ...base, type: 'approval_request',
    requestId: request.id, requestKind: 'command', options: [{ decision: 'accept', label: 'Only once' },
      { decision: 'decline', label: 'No' }] })
  const decision = { type: 'runtime-request.respond', commandId: 'command:original', threadId: base.threadId,
    requestId: request.id, decision: 'accept' }
  const current = { command: Schema.decodeUnknownSync(S.OrchestrationV2Command)(decision),
    item: approval, request: { ...request, kind: 'command' }, activeProviderSessionId: 'provider:current' }
  assert.doesNotThrow(() => validate(current))
  assert.throws(() => validate({ ...current, command: { ...current.command, decision: 'acceptAlways' } }), /answer_invalid/)
  assert.throws(() => validate({ ...current, command: { ...current.command, feedback: 'nope pls' } }), /answer_invalid/)
  assert.throws(() => validate({ ...current, command: { ...current.command, answers: {} } }), /answer_invalid/)
})
