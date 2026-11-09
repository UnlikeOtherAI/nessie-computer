import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { captureProviderFrameMetadata } from '../../dist/t3-session/runtime/frame-metadata.js'

test('driver projections preserve actual encoded IDs and exact bytes, including cancellation', () => {
  for (const [driver, value, expected] of [
    ['codex', { id: -1, method: 'thread/start', params: { text: '東京' } },
      { kind: 'request', protocolId: -1, method: 'thread/start' }],
    ['codex', { method: '$/cancelRequest', params: { id: -1 } }, { kind: 'cancel', method: '$/cancelRequest' }],
    ['claude', { type: 'control_request', request_id: 'init-id', request: { subtype: 'initialize' } },
      { kind: 'request', protocolId: 'init-id', method: 'initialize' }],
    ['claude', { type: 'control_cancel_request', request_id: 'init-id' }, { kind: 'cancel', protocolId: 'init-id' }],
    ['claude', { type: 'user', uuid: 'original-message', message: { role: 'user', content: 'Žluťoučký 🦊' } },
      { kind: 'message', messageId: 'original-message' }],
  ]) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n')
    assert.deepEqual(captureProviderFrameMetadata(driver, bytes), { driver, ...expected,
      frameSha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') })
  }
})

test('bootstrap metadata cannot promote a response or unknown driver/frame into answer authority', () => {
  for (const [driver, value] of [['codex', { id: 1, result: {} }],
    ['claude', { type: 'control_response', response: { request_id: '1', subtype: 'success' } }],
    ['claude', { type: 'invented' }], ['other', { method: 'initialize' }]]) {
    assert.throws(() => captureProviderFrameMetadata(driver, Buffer.from(JSON.stringify(value) + '\n')))
  }
})
