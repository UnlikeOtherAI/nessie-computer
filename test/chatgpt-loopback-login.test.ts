import assert from 'node:assert/strict'
import { request } from 'node:http'
import test from 'node:test'
import type { ChatgptTokens, ChatgptOAuthRequest } from '../src/chatgpt-oauth-provider.js'
import { startChatgptLoopbackLogin } from '../src/chatgpt-loopback-login.js'

const tokens: ChatgptTokens = { issuer: 'https://auth.openai.com', subject: 'verified-subject', idToken: 'fixture-id',
  accessToken: null, refreshToken: null, scopes: ['openid'], expiresAt: null }
const fixture = () => {
  let pending!: ChatgptOAuthRequest
  const exchanges: { clientId: string; redirectUri: string; verifier: string; nonce: string; subject?: string }[] = []
  const provider = {
    authorizationUrl: async (input: ChatgptOAuthRequest) => {
      pending = input
      return `https://auth.openai.com/api/accounts/authorize?state=${input.state}`
    },
    exchange: async (input: typeof exchanges[number]) => { exchanges.push(input); return tokens },
  }
  return { provider, exchanges, pending: () => pending }
}
const callback = (uri: string, query: Record<string, string>, method = 'GET', host?: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const url = new URL(uri)
    for (const [key, value] of Object.entries(query)) url.searchParams.append(key, value)
    const outgoing = request(url, { method, headers: host ? { host } : {}, timeout: 2_000 }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode!))
    })
    outgoing.on('error', reject)
    outgoing.on('timeout', () => outgoing.destroy(new Error('Fixture callback timed out')))
    outgoing.end()
  })

test('new registration binds exact loopback URI and fresh state/nonce/PKCE to one verified exchange', async () => {
  const world = fixture()
  const login = await startChatgptLoopbackLogin({ hostId: 'urn:uuid:fixture-host' }, world.provider)
  try {
    const pending = world.pending()
    assert.match(login.callbackUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/u)
    assert.equal(pending.redirectUri, login.callbackUri)
    assert.equal(pending.clientId, null)
    assert.equal(new Set([pending.state, pending.nonce, pending.verifier]).size, 3)
    assert.equal(await callback(login.callbackUri, { state: 'wrong-state', code: 'fixture-code',
      client_id: 'oaiapp_fixture' }), 400)
    assert.equal(login.status(), 'awaiting_browser')
    assert.equal(world.exchanges.length, 0)
    assert.equal(await callback(login.callbackUri, { state: pending.state, code: 'fixture-code',
      client_id: 'oaiapp_fixture' }), 200)
    const result = await login.completion
    assert.equal(result.status, 'verified')
    assert.deepEqual(world.exchanges.map(({ clientId, redirectUri, verifier, nonce }) =>
      ({ clientId, redirectUri, verifier, nonce })), [{ clientId: 'oaiapp_fixture', redirectUri: login.callbackUri,
      verifier: pending.verifier, nonce: pending.nonce }])
  } finally { await login.cancel() }
})

test('a returning registration cannot be replaced and callback duplicates cannot start another exchange', async () => {
  const mismatch = fixture()
  const rejected = await startChatgptLoopbackLogin({ hostId: 'fixture-host', clientId: 'oaiapp_original',
    expectedSubject: 'original-subject' }, mismatch.provider)
  try {
    assert.equal(await callback(rejected.callbackUri, { state: mismatch.pending().state,
      code: 'fixture-code', client_id: 'oaiapp_other' }), 400)
    assert.deepEqual(await rejected.completion, { status: 'failed', code: 'oauth_callback_invalid' })
    assert.equal(mismatch.exchanges.length, 0)
  } finally { await rejected.cancel() }
  const world = fixture()
  let finish!: (value: ChatgptTokens) => void
  const paused = new Promise<ChatgptTokens>((resolve) => { finish = resolve })
  let began!: () => void
  const started = new Promise<void>((resolve) => { began = resolve })
  const login = await startChatgptLoopbackLogin({ hostId: 'fixture-host', clientId: 'oaiapp_original',
    expectedSubject: 'original-subject' }, { ...world.provider, exchange: async (input) => {
    world.exchanges.push(input); began(); return paused
  } })
  try {
    const query = { state: world.pending().state, code: 'fixture-code' }
    const first = callback(login.callbackUri, query)
    await started
    assert.equal(await callback(login.callbackUri, query), 409)
    finish(tokens)
    assert.equal(await first, 200)
    assert.equal((await login.completion).status, 'verified')
    assert.equal(world.exchanges.length, 1)
    assert.equal(world.exchanges[0]!.subject, 'original-subject')
  } finally { finish(tokens); await login.cancel() }
})

test('cancellation fences even a late successful exchange and expiry closes the listener', async () => {
  const world = fixture()
  let finish!: (value: ChatgptTokens) => void
  const late = new Promise<ChatgptTokens>((resolve) => { finish = resolve })
  let began!: () => void
  const started = new Promise<void>((resolve) => { began = resolve })
  const login = await startChatgptLoopbackLogin({ hostId: 'fixture-host' }, { ...world.provider,
    exchange: async (input) => { world.exchanges.push(input); began(); return late } })
  const response = callback(login.callbackUri, { state: world.pending().state, code: 'fixture-code',
    client_id: 'oaiapp_fixture' }).catch(() => 0)
  await started
  await login.cancel()
  finish(tokens)
  assert.deepEqual(await login.completion, { status: 'cancelled', code: 'oauth_cancelled' })
  await response
  assert.equal(login.status(), 'cancelled')
  const expiring = await startChatgptLoopbackLogin({ hostId: 'fixture-host', lifetimeMs: 5 }, fixture().provider)
  assert.deepEqual(await expiring.completion, { status: 'expired', code: 'oauth_expired' })
  await expiring.cancel()
  await assert.rejects(callback(expiring.callbackUri, {}))
})

test('forged Host, POST, duplicate state and declined consent do not exchange a code', async () => {
  const world = fixture()
  const login = await startChatgptLoopbackLogin({ hostId: 'fixture-host' }, world.provider)
  try {
    const query = { state: world.pending().state, code: 'fixture-code', client_id: 'oaiapp_fixture' }
    assert.equal(await callback(login.callbackUri, query, 'GET', 'evil.example'), 400)
    assert.equal(await callback(login.callbackUri, query, 'POST'), 400)
    const duplicate = new URL(login.callbackUri)
    duplicate.searchParams.append('state', world.pending().state)
    assert.equal(await callback(duplicate.toString(), { ...query, state: 'unbound' }), 400)
    assert.equal(await callback(login.callbackUri, { state: world.pending().state, error: 'access_denied' }), 400)
    assert.deepEqual(await login.completion, { status: 'failed', code: 'oauth_access_denied' })
    assert.equal(world.exchanges.length, 0)
  } finally { await login.cancel() }
})
