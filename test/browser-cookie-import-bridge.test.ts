import assert from 'node:assert/strict'
import test from 'node:test'

import { createBrowserCookieImportBridge } from '../src/browser-cookie-import-bridge.js'
import { decodeChromeNativeMessages, encodeChromeNativeMessage } from '../src/chrome-native-messaging.js'

const offer = {
  destination: { agentName: 'Personal Assistant', retention: 'Kept in your private browser until revoked.', userName: 'Ada' },
  expiresAt: '2099-01-01T00:00:00.000Z',
  origins: ['https://app.example.test'],
  requestId: '00000000-0000-4000-8000-000000000701',
}

test('cookie import exposes only a consent offer and sends one bounded payload to its dedicated transport', async () => {
  const uploads: Array<Record<string, unknown>> = []
  const bridge = createBrowserCookieImportBridge({
    pending: async () => offer,
    upload: async (input) => { uploads.push(input) },
  })
  assert.deepEqual(await bridge.handle({ type: 'browser_cookie_import.hello.v1' }), {
    ...offer,
    type: 'browser_cookie_import.offer.v1',
  })
  const cookies = {
    imports: [{
      cookies: [{ domain: '.example.test', name: 'session', path: '/', value: 'secret-never-a-result' }],
      origin: 'https://app.example.test',
    }],
    version: 1,
  }
  assert.deepEqual(await bridge.handle({
    cookies,
    requestId: offer.requestId,
    selectedOrigins: ['https://app.example.test'],
    type: 'browser_cookie_import.submit.v1',
  }), {
    requestId: offer.requestId,
    type: 'browser_cookie_import.accepted.v1',
  })
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0]?.cookies, cookies)
  assert.match(uploads[0]?.payloadDigest as string, /^sha256:[a-f0-9]{64}$/)
})

test('cookie import refuses an unoffered origin before it reaches the transport', async () => {
  let uploads = 0
  const bridge = createBrowserCookieImportBridge({
    pending: async () => offer,
    upload: async () => { uploads += 1 },
  })
  await bridge.handle({ type: 'browser_cookie_import.hello.v1' })
  assert.deepEqual(await bridge.handle({
    cookies: { imports: [], version: 1 },
    requestId: offer.requestId,
    selectedOrigins: ['https://elsewhere.example.test'],
    type: 'browser_cookie_import.submit.v1',
  }), {
    code: 'BROWSER_COOKIE_IMPORT_REJECTED',
    type: 'browser_cookie_import.result.v1',
  })
  assert.equal(uploads, 0)
})

test('native messaging uses bounded little-endian frames and preserves incomplete input', () => {
  const first = encodeChromeNativeMessage({ type: 'first' })
  const second = encodeChromeNativeMessage({ type: 'second' })
  const partial = Buffer.concat([first, second.subarray(0, 5)])
  const decoded = decodeChromeNativeMessages(partial)
  assert.deepEqual(decoded.frames, [{ type: 'first' }])
  assert.deepEqual(decodeChromeNativeMessages(Buffer.concat([decoded.remainder, second.subarray(5)])).frames, [
    { type: 'second' },
  ])
  assert.throws(() => decodeChromeNativeMessages(Buffer.from([0, 0, 0, 0])), /invalid/)
})
