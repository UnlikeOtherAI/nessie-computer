import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { SignJWT } from 'jose'
import { CHATGPT_ISSUER, CHATGPT_RESOURCE, ChatgptOAuthProvider, hasChatgptPlanPermission } from '../src/chatgpt-oauth-provider.js'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const clientId = 'oaiapp_fixture_nessie'
const nonce = 'nonce-fixture'
const now = Date.now()
const identity = (claims: Record<string, unknown> = {}, issuer = CHATGPT_ISSUER, audience = clientId) =>
  new SignJWT({ nonce, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .setIssuer(issuer).setAudience(audience).setSubject('workspace-subject').setIssuedAt(Math.floor(now / 1_000))
    .setExpirationTime(Math.floor(now / 1_000) + 3600).sign(pair.privateKey)
const fixture = (tokens: Record<string, unknown>) => {
  const requests: { url: string; init: RequestInit }[] = []
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    requests.push({ url, init })
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: CHATGPT_ISSUER,
      authorization_endpoint: `${CHATGPT_ISSUER}/api/accounts/authorize`,
      token_endpoint: `${CHATGPT_ISSUER}/api/accounts/oauth/token`,
      jwks_uri: `${CHATGPT_ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${CHATGPT_ISSUER}/revoke` })
    if (url.endsWith('jwks.json')) return Response.json({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }),
      alg: 'RS256', use: 'sig', kid: 'fixture-key' }] })
    if (url.endsWith('oauth/token')) return Response.json(tokens)
    if (url.endsWith('/revoke')) return new Response(null, { status: 200 })
    throw new Error('Unexpected fixture endpoint')
  }
  return { provider: new ChatgptOAuthProvider(fetcher, () => now), requests }
}

test('Nessie dynamic registration and returning authorization retain exact issued registration and loopback path', async () => {
  const { provider } = fixture({})
  const request = { clientId: null, hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    redirectUri: 'http://127.0.0.1:1455/auth/callback', state: 'state', nonce, verifier: 'verifier' }
  const first = new URL(await provider.authorizationUrl(request))
  assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(first.searchParams.get('agent_name_hint'), 'Nessie')
  assert.equal(first.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(first.searchParams.get('resource'), CHATGPT_RESOURCE)
  const returning = new URL(await provider.authorizationUrl({ ...request, clientId, idTokenHint: 'fixture-id-hint' }))
  assert.equal(returning.searchParams.get('client_id'), clientId)
  assert.equal(returning.searchParams.has('agent_name_hint'), false)
  assert.equal(returning.searchParams.get('ext_agent_host_id'), request.hostId)
  for (const redirectUri of ['http://localhost:1455/auth/callback', 'http://127.0.0.1:1455/callback',
    'https://127.0.0.1:1455/auth/callback', 'http://127.0.0.1:1455/auth/callback?extra=1']) {
    await assert.rejects(provider.authorizationUrl({ ...request, redirectUri }), /callback_invalid/u)
  }
})

test('ID token requires signature, issuer, audience, nonce and selected workspace identity', async () => {
  const { provider } = fixture({})
  const token = await identity()
  assert.equal(await provider.verifyIdentity(token, clientId, nonce, 'workspace-subject'), 'workspace-subject')
  await assert.rejects(provider.verifyIdentity(token, clientId, 'forged'), /identity_invalid/u)
  await assert.rejects(provider.verifyIdentity(token, clientId, nonce, 'another-workspace'), /identity_invalid/u)
  await assert.rejects(provider.verifyIdentity(await identity({}, 'https://attacker.example'), clientId, nonce),
    /identity_invalid/u)
  await assert.rejects(provider.verifyIdentity(await identity({}, CHATGPT_ISSUER, 'other-client'), clientId, nonce),
    /identity_invalid/u)
  const altered = token.split('.')
  altered[1] = Buffer.from(JSON.stringify({ nonce, sub: 'attacker' })).toString('base64url')
  await assert.rejects(provider.verifyIdentity(altered.join('.'), clientId, nonce), /identity_invalid/u)
})

test('identity-only sign-in remains distinct from plan-use; code exchange never uses dynamic client id', async () => {
  const { provider, requests } = fixture({ id_token: await identity(), scope: 'openid profile email' })
  const input = { clientId, code: 'fixture-code', verifier: 'fixture-verifier', nonce,
    redirectUri: 'http://127.0.0.1:1455/auth/callback' }
  const tokens = await provider.exchange(input)
  assert.equal(hasChatgptPlanPermission(tokens), false)
  assert.equal(tokens.accessToken, null)
  assert.equal(tokens.subject, 'workspace-subject')
  const body = requests.find((request) => request.url.endsWith('oauth/token'))!.init.body as URLSearchParams
  assert.equal(body.get('client_id'), clientId)
  assert.equal(body.get('redirect_uri'), input.redirectUri)
  await assert.rejects(provider.exchange({ ...input, clientId: 'dynamic_agent_client' }), /client_invalid/u)
})

test('refresh replaces credential fields together, retains absent scopes, and sends no scope parameter', async () => {
  const { provider, requests } = fixture({ access_token: 'fixture-access-new', refresh_token: 'fixture-refresh-new',
    token_type: 'Bearer', expires_in: 3600 })
  const previous = { idToken: await identity(), issuer: CHATGPT_ISSUER, subject: 'workspace-subject',
    accessToken: 'fixture-access-old', refreshToken: 'fixture-refresh-old', expiresAt: now,
    scopes: ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'] }
  const current = await provider.refresh(clientId, previous, new AbortController().signal)
  assert.equal(current.accessToken, 'fixture-access-new')
  assert.equal(current.refreshToken, 'fixture-refresh-new')
  assert.deepEqual(current.scopes, previous.scopes)
  assert.equal(hasChatgptPlanPermission(current), true)
  const body = requests.find((request) => request.url.endsWith('oauth/token'))!.init.body as URLSearchParams
  assert.equal(body.has('scope'), false)
  assert.equal(body.get('client_id'), clientId)
  assert.equal(body.get('resource'), CHATGPT_RESOURCE)
  assert.equal(await provider.revoke(clientId, current.refreshToken!, new AbortController().signal), true)
})

test('malformed HTTP 200 refresh never restores a spent predecessor or retries its grant', async () => {
  const previous = { idToken: await identity(), issuer: CHATGPT_ISSUER, subject: 'workspace-subject',
    accessToken: 'fixture-access-old', refreshToken: 'fixture-refresh-old', expiresAt: now,
    scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'] }
  const complete = { access_token: 'fixture-access-new', refresh_token: 'fixture-refresh-new',
    token_type: 'Bearer', expires_in: 3600 }
  for (const value of [
    { ...complete, refresh_token: undefined }, { ...complete, refresh_token: '' },
    { ...complete, access_token: undefined }, { ...complete, access_token: '' },
    { ...complete, token_type: 'Basic' }, { ...complete, expires_in: 0 },
  ]) {
    const { provider, requests } = fixture(value)
    await assert.rejects(provider.refresh(clientId, previous, new AbortController().signal), /response_invalid/u)
    assert.equal(requests.filter((request) => request.url.endsWith('oauth/token')).length, 1)
    assert.equal(previous.refreshToken, 'fixture-refresh-old')
  }
})
