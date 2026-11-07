import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'

import { sourceFunctions } from '../t3-session-client-connection/source-functions.mjs'
import { buildRequestPrivacyManifest } from './build-manifest.mjs'
import { readRequestSource } from './source-fixture.mjs'
import {
  applyRequestPrivacyPatches, requestPrivacyManifestBytes, T3_REQUEST_PRIVACY_PATCHES,
} from '../../patches/t3-session/requests/index.mjs'

const { original, snapshot, privacy } = await readRequestSource()
const canary = ['synthetic', 'private', 'C05', '\u{1f9ed}', 'e\u0301'].join('-')
const noCanary = value => assert.equal(JSON.stringify(value).includes(canary), false)
const secretTool = 'mcp__t3_code__request_secret'
const input = { label: 'Token', reason: 'Synthetic operation', clientRequestId: '__proto__', value: ` \r\n${canary} \n` }

test('manifest is reproducible and rejects wrong/intermediate source and replay', () => {
  assert.deepEqual(buildRequestPrivacyManifest(original), requestPrivacyManifestBytes)
  assert.equal(createHash('sha256').update(requestPrivacyManifestBytes).digest('hex'), T3_REQUEST_PRIVACY_PATCHES.manifestSha256)
  assert.throws(() => applyRequestPrivacyPatches(snapshot), /SOURCE_MISMATCH/)
  const changed = { ...original, read: file => Buffer.concat([original.read(file), Buffer.from(' ')]) }
  assert.throws(() => applyRequestPrivacyPatches(changed), /SOURCE_MISMATCH/)
  const wrong = { ...original, identity: { ...original.identity, commit: '0'.repeat(40) } }
  assert.throws(() => applyRequestPrivacyPatches(wrong), /MANIFEST_REFUSED/)
  for (const file of new Set(JSON.parse(requestPrivacyManifestBytes).patches.map(patch => patch.file))) {
    assert.doesNotThrow(() => stripTypeScriptTypes(snapshot.read(file).toString(), { sourceUrl: file }))
  }
})

test('exact registered identities redact; wrong servers, loose presentation labels and user tools remain intact', () => {
  for (const server of ['t3-code', 't3_code', 't3code', 't3-code-direct', 't3_code_direct']) {
    for (const name of [`${server}.request_secret`, `mcp__${server}__request_secret`]) {
      noCanary(privacy.projectSecretRequestInput(name, input))
      noCanary(privacy.projectSecretRequestOutput(name, { error: canary }))
    }
  }
  for (const name of ['request_secret', 'foreign.request_secret', 'mcp__foreign__request_secret',
    't3-code.request_secret_extra', 'T3-CODE.request_secret', 't3-code/request_secret', 'my-tool']) {
    assert.equal(privacy.isSecretRequestTool(name), false)
    assert.equal(privacy.projectSecretRequestInput(name, input), input)
    assert.equal(privacy.projectSecretRequestOutput(name, input), input)
  }
  assert.equal(input.value, ` \r\n${canary} \n`, 'ephemeral operation input is untouched')
})

test('malformed and string-encoded secret arguments fail closed without leaking unknown fields', () => {
  for (const value of [canary, JSON.stringify(input), '{' + canary, null, [canary],
    { label: { unexpected: canary }, value: canary, extra: { nested: canary } }]) {
    noCanary(privacy.projectSecretRequestInput(secretTool, value))
  }
})

test('mixed nested SDK/MCP batches correlate outputs, errors and replay without retaining real arguments', () => {
  const project = privacy.createRequestPrivacyProjector()
  const publicControl = { id: 'control', type: 'node.updated', status: 'running', title: 'Čekám na odpověď' }
  const frames = [
    { event: { stage: 'decoded', payload: { type: 'tool_result', tool_use_id: 'secret-1', content: canary, is_error: true } } },
    { message: { content: [{ type: 'tool_use', id: 'secret-1', name: secretTool, input }] } },
    { type: 'mcpToolCall', id: 'secret-2', server: 't3-code', tool: 'request_secret', arguments: JSON.stringify(input),
      result: { structuredContent: input }, error: { message: canary } },
    { type: 'dynamicToolCall', id: 'secret-3', namespace: 't3_code_direct', tool: 'request_secret', arguments: input,
      contentItems: [{ type: 'inputText', text: canary }] },
    { jsonrpc: '2.0', id: 7, server: 't3-code', method: 'tools/call', params: { name: 'request_secret', arguments: input } },
    { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: canary }] } },
    publicControl,
  ]
  const projected = project(frames)
  noCanary(projected)
  assert.deepEqual(projected.at(-1), publicControl)
  assert.equal(projected[1].message.content[0].id, 'secret-1')
  assert.equal(projected[2].server, 't3-code')
  noCanary(project({ tool_use_id: 'secret-1', type: 'tool_result', content: canary }))
  assert.deepEqual(project(projected), projected, 'replayed public frames are stable')
  assert.equal(frames[1].message.content[0].input, input)
  const ordinary = { type: 'tool_use', id: 'normal', name: 'foreign.request_secret', input, error: canary }
  assert.deepEqual(project(ordinary), ordinary, 'other tools are not censored by an earlier secret call')
})

test('explicit secret question fields preserve IDs and ordinals; unsupported ordinary-answer lane refuses them', () => {
  const questions = [{ id: '__proto__', isSecret: true, fieldOrdinal: 3, answerOrdinal: 2,
    answer: canary, initialValue: canary, preview: canary, header: 'Token' }]
  const project = privacy.createRequestPrivacyProjector()
  const safe = project({ questions })
  noCanary(safe)
  assert.equal(safe.questions[0].id, '__proto__')
  assert.equal(safe.questions[0].fieldOrdinal, 3)
  assert.equal(safe.questions[0].answerOrdinal, 2)
  noCanary(project({ answers: JSON.parse(`{"__proto__":{"answers":["${canary}"]}}`) }))
  assert.deepEqual(project({ answers: { ordinary: { answers: ['normal'] } } }), { answers: { ordinary: { answers: ['normal'] } } })
  assert.throws(() => privacy.assertPublicUserInputQuestions(questions), /^Error: canonical_secret_question_port_required$/)
  assert.doesNotThrow(() => privacy.assertPublicUserInputQuestions([{ id: 'ordinary', isSecret: false }]))
})

test('cyclic, oversized and exhausted metadata fail closed, including future replay', () => {
  const cyclic = { value: canary }; cyclic.next = cyclic
  const project = privacy.createRequestPrivacyProjector()
  noCanary(project(cyclic))
  noCanary(project(input))
  noCanary(privacy.createRequestPrivacyProjector()(Array.from({ length: 33000 }, () => ({ value: canary }))))
})

test('dedicated answer helper preserves spaces, line endings and Unicode and rejects only truly empty strings', () => {
  const { secretRequestAnswerInput } = sourceFunctions(snapshot, 'packages/client-runtime/src/secretRequest.ts',
    'export function secretRequestAnswerInput(', 'const USER_FACING_FAILURE_TAGS', ['secretRequestAnswerInput'])
  const item = { id: 'turn-item:__proto__', threadId: 'thread:opaque' }
  for (const secret of [` ${canary} `, '\n', '\r\n', '   ', `\r\n${canary}\n`, '\u{1f9ed}e\u0301', '\u0000x']) {
    const result = secretRequestAnswerInput(item, { type: 'save', secret })
    assert.equal(result.answer.secret, secret)
    assert.equal(result.threadId, item.threadId)
    assert.equal(result.turnItemId, item.id)
  }
  assert.equal(secretRequestAnswerInput(item, { type: 'save', secret: '' }), null)
  assert.deepEqual(secretRequestAnswerInput(item, { type: 'decline' }).answer, { type: 'decline' })
})
