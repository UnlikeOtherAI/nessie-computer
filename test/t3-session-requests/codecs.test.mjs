import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { createSourceModuleLoader } from '../t3-session-client-connection/module-loader.mjs'
import { sourceFunctions } from '../t3-session-client-connection/source-functions.mjs'
import { readRequestSource, scratch } from './source-fixture.mjs'

const { snapshot } = await readRequestSource()
const loader = createSourceModuleLoader(snapshot, { dependencyDirectory: resolve(scratch, 'dependencies') })
const Schema = await loader.external('effect/Schema')
const Option = await loader.external('effect/Option')
const secret = await loader.load('packages/contracts/src/secretRequest.ts')
const mcp = await loader.load('packages/contracts/src/orchestratorMcp.ts')
const { secretRequestAnswerInput } = sourceFunctions(snapshot, 'packages/client-runtime/src/secretRequest.ts',
  'export function secretRequestAnswerInput(', 'const USER_FACING_FAILURE_TAGS', ['secretRequestAnswerInput'])

test('real dedicated and pasted Effect 4.1.2 codecs encode/decode exact supplied values', () => {
  const item = { id: 'item:__proto__', threadId: 'thread:opaque' }
  const dedicatedDecode = Schema.decodeUnknownSync(secret.SecretRequestAnswerInput)
  const dedicatedEncode = Schema.encodeSync(secret.SecretRequestAnswerInput)
  const pastedDecode = Schema.decodeUnknownSync(mcp.OrchestratorMcpRequestSecretInput)
  const pastedEncode = Schema.encodeSync(mcp.OrchestratorMcpRequestSecretInput)
  for (const value of [' value ', '  ', '\n', '\r\n', 'line1\r\nline2\n', '\u{1f9ed}e\u0301é', '\u0000x']) {
    const answer = secretRequestAnswerInput(item, { type: 'save', secret: value })
    const decoded = dedicatedDecode(answer)
    assert.equal(decoded.answer.secret, value)
    assert.deepEqual(Buffer.from(decoded.answer.secret, 'utf8'), Buffer.from(value, 'utf8'))
    assert.equal(dedicatedEncode(decoded).answer.secret, value)
    const pasted = pastedDecode({ label: ' Token ', reason: ' Required ', value, clientRequestId: '__proto__' })
    assert.equal(pasted.value, value)
    assert.equal(pastedEncode(pasted).value, value)
    assert.equal(pasted.label, 'Token', 'ordinary labels retain their existing normalization')
    assert.equal(pasted.reason, 'Required')
    assert.equal(decoded.turnItemId, item.id)
  }
})

test('real codecs reject empty and malformed values without fixtures containing a retained secret', () => {
  const dedicatedDecode = Schema.decodeUnknownOption(secret.SecretRequestAnswerInput)
  const pastedDecode = Schema.decodeUnknownOption(mcp.OrchestratorMcpRequestSecretInput)
  for (const value of ['', null, 42, {}, []]) {
    assert.equal(Option.isNone(dedicatedDecode({ threadId: 't', turnItemId: 'i', answer: { type: 'save', secret: value } })), true)
    assert.equal(Option.isNone(pastedDecode({ label: 'Token', reason: 'Required', value })), true)
  }
  assert.equal(Option.isSome(dedicatedDecode({ threadId: 't', turnItemId: 'i', answer: { type: 'decline' } })), true)
})
