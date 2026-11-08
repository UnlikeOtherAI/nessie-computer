import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserThreadHost, SourceContracts } from '@nessie/t3-session-source/client'

const base = 'https://api.example/t3/environments/exact%25route/'
const input = () => ({
  connection: { environmentId: SourceContracts.EnvironmentId.make('original-environment'),
    endpoint: { httpBaseUrl: base, wsBaseUrl: base.replace('https:', 'wss:') + 'ws' },
    credential: 'synthetic-one-use', expiresAt: new Date(Date.now() + 60_000).toISOString() },
  threadId: SourceContracts.ThreadId.make('original-thread'), scopeKey: 'team-generation:checked-detail',
  authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString(), signal: new AbortController().signal,
  onState: () => { throw Error('Bootstrap must not publish a state') },
})
const install = (t, fetch) => {
  const values = new Map(), calls = []
  const window = new EventTarget(), document = new EventTarget()
  window.sessionStorage = { get length() { return values.size }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key) }
  document.visibilityState = 'visible'
  for (const [name, value] of Object.entries({ window, document, navigator: { onLine: true },
    fetch: async (...args) => { calls.push(String(args[0])); return fetch(...args) },
    WebSocket: class { constructor() { throw Error('Unexpected socket before admission') } } })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
    t.after(() => { if (before) Object.defineProperty(globalThis, name, before); else delete globalThis[name] })
  }
  return { values, calls, window }
}
const descriptor = environmentId => Response.json({ environmentId, label: 'Fixture',
  orchestrationProtocolVersion: 2, platform: { os: 'windows', arch: 'x64' },
  serverVersion: 'fixture', capabilities: { repositoryIdentity: false } })

test('normal host refuses expired admission without spending the credential', async t => {
  const f = install(t, () => { throw Error('Unexpected HTTP') })
  await assert.rejects(BrowserThreadHost.open({ ...input(), authorizationExpiresAt: new Date(0).toISOString() }))
  assert.equal(f.calls.length, 0)
})

test('normal host refuses failed cold cleanup before HTTP', async t => {
  const f = install(t, () => { throw Error('Unexpected HTTP') })
  f.values.set('nessie:t3-detail:v1:previous:thread', 'synthetic prior cache')
  f.window.sessionStorage.removeItem = () => { throw Error('synthetic failure') }
  await assert.rejects(BrowserThreadHost.open(input()), /CLEANUP_FAILED/u)
  assert.equal(f.calls.length, 0)
})

test('normal host checks the mounted original descriptor before exchanging bootstrap material', async t => {
  const f = install(t, () => descriptor('wrong-environment'))
  await assert.rejects(BrowserThreadHost.open(input()))
  assert.deepEqual(f.calls, [base + '.well-known/t3/environment'])
  assert.equal(f.values.size, 0)
})

test('normal host does not treat a DPoP token as bearer or publish bootstrap as live state', async t => {
  let count = 0
  const f = install(t, () => ++count === 1 ? descriptor('original-environment') : Response.json({
    access_token: 'synthetic-access', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    token_type: 'DPoP', expires_in: 60, scope: 'orchestration:read',
  }))
  await assert.rejects(BrowserThreadHost.open(input()))
  assert.deepEqual(f.calls, [base + '.well-known/t3/environment', base + 'oauth/token'])
  assert.equal(f.values.size, 0)
})
