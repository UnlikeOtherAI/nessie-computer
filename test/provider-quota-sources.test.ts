import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ExecutorSubscription } from '@nessie/executor-protocol'
import { cursorUsageWindows, readCursorQuota } from '../src/provider-process/cursor-quota.js'
import { grokBuildUsageWindows, readGrokBuildQuota } from '../src/provider-process/grok-build-quota.js'
import { antigravitySummaryWindows, antigravityModelWindows,
  readAntigravityQuotas } from '../src/provider-process/antigravity-quota.js'
import { readCliProxyQuotas } from '../src/provider-process/cliproxy-quota.js'
import { boundQuotaResponse } from '../src/provider-process/quota-fetch.js'
import { collectQuotaSources } from '../src/provider-process/quota-source-collection.js'

const at = '2026-11-07T12:00:00.000Z'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const jwt = (subject: string) => `fixture.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.fixture`

test('Cursor preserves its two model pools without counting overall usage as a third allowance', () => {
  const windows = cursorUsageWindows({ billingCycleEnd: String(Date.parse(at)), planUsage: {
    totalPercentUsed: 80, autoPercentUsed: 100, apiPercentUsed: 25,
  } })
  assert.deepEqual(windows.map(window => [window.id, window.remainingPercent]),
    [['autoPercentUsed', 0], ['apiPercentUsed', 75]])
  assert.equal(windows[0]?.resetsAt, at)
  assert.equal(cursorUsageWindows({ planUsage: { totalPercentUsed: 0 } })[0]?.remainingPercent, 100)
  assert.deepEqual(cursorUsageWindows({ planUsage: { autoPercentUsed: null } }), [])
})

test('Cursor exchanges the configured key, reads the real account and deduplicates different keys by subject', async () => {
  const calls: string[] = []
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input)
    calls.push(url)
    assert.equal(options?.redirect, 'error')
    if (url.endsWith('/exchange_user_api_key')) return json({ accessToken: jwt('same-cursor-person') })
    if (url.endsWith('/v1/me')) return json({ userEmail: 'person@example.test' })
    assert(url.endsWith('/GetCurrentPeriodUsage'))
    return json({ planUsage: { autoPercentUsed: 10, apiPercentUsed: 20 } })
  }
  const first = await readCursorQuota({ CURSOR_API_KEY: 'fixture-key-one' }, { fetch: fetcher })
  const second = await readCursorQuota({ CURSOR_API_KEY: 'fixture-key-two' }, { fetch: fetcher })
  assert.equal(first?.status, 'ready')
  assert.equal(first?.account, 'person@example.test')
  assert.equal(first?.accountKey, second?.accountKey)
  assert(!JSON.stringify(first).includes('fixture-key'))
  const count = calls.length
  assert.equal(await readCursorQuota({}, { fetch: fetcher }), null)
  assert.equal((await readCursorQuota({ CURSOR_API_KEY: 'fixture', CURSOR_API_ENDPOINT: 'https://example.test' },
    { fetch: fetcher }))?.status, 'unsupported')
  assert.equal(calls.length, count)
  assert.equal((await readCursorQuota({ CURSOR_AUTH_TOKEN: 'fixture-expired' }, {
    fetch: async () => json({}, 401),
  }))?.status, 'signed_out')
})

test('Grok Build only treats an omitted percent as zero for a complete valid subscription period', () => {
  const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: at, end: '2026-11-14T12:00:00.000Z' }
  assert.equal(grokBuildUsageWindows({ config: { currentPeriod: period } })[0]?.remainingPercent, 100)
  assert.deepEqual(grokBuildUsageWindows({ config: {} }), [])
  assert.deepEqual(grokBuildUsageWindows({ config: { currentPeriod: { ...period, start: '2026-02-31T12:00:00Z' } } }), [])
  assert.deepEqual(grokBuildUsageWindows({ config: { creditUsagePercent: null, currentPeriod: period } }), [])
  assert.equal(grokBuildUsageWindows({ config: { creditUsagePercent: 125 } })[0]?.remainingPercent, 0)
})

test('Grok Build respects the selected native realm and never borrows credentials from a custom deployment', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-grok-quota-'))
  let reads = 0
  const fetcher: typeof fetch = async input => {
    reads++
    assert.equal(String(input), 'https://cli-chat-proxy.grok.com/v1/billing?format=credits')
    return json({ config: { creditUsagePercent: 30, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: at } } })
  }
  try {
    await mkdir(join(home, '.grok'))
    await writeFile(join(home, '.grok/auth.json'), JSON.stringify({
      'https://accounts.x.ai/sign-in': { key: 'fixture-grok-token', email: 'person@example.test' },
      'https://another-deployment.test': { key: 'fixture-wrong-token' },
    }))
    const reading = await readGrokBuildQuota({}, { home, fetch: fetcher })
    assert.equal(reading?.provider, 'grok_build')
    assert.equal(reading?.account, 'person@example.test')
    assert.equal(reading?.windows[0]?.remainingPercent, 70)
    assert(!JSON.stringify(reading).includes('fixture-grok-token'))
    assert.equal(await readGrokBuildQuota({ XAI_API_KEY: 'fixture-api-key' }, { home, fetch: fetcher }), null)
    await writeFile(join(home, '.grok/config.toml'), '[auth]\nissuer="https://example.test"')
    assert.equal(await readGrokBuildQuota({}, { home, fetch: fetcher }), null)
    await writeFile(join(home, '.grok/config.toml'), 'x'.repeat(64 * 1024 + 1))
    await assert.rejects(readGrokBuildQuota({}, { home, fetch: fetcher }), /configuration could not be read/)
    assert.equal(reads, 1)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('Antigravity preserves shared buckets, blank rolling resets and restrictive legacy model readings', () => {
  const windows = antigravitySummaryWindows({ groups: [{ buckets: [
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1,
      resetTime: new Date(Date.parse(at) + 300 * 60_000).toISOString() },
    { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.2, resetTime: at },
    { bucketId: 'disabled', disabled: true, remainingFraction: 1 },
    { bucketId: 'unknown' },
  ] }] }, Date.parse(at))
  assert.equal(windows.length, 2)
  assert.equal(windows[0]?.resetsAt, null)
  assert.equal(windows[1]?.label, 'Claude & GPT')
  const legacy = antigravityModelWindows({ models: {
    'gemini-a': { quotaInfo: { remainingFraction: 0.8 } },
    'gemini-b': { quotaInfo: { remainingFraction: 0.2 } },
    'claude-a': { weeklyQuotaInfo: { remainingFraction: 0.5 } },
  } })
  assert.equal(legacy.find(window => window.id === 'gemini-quota')?.remainingPercent, 20)
  assert.equal(legacy.find(window => window.id === 'gemini-quota')?.kind, 'other')
})

test('Antigravity profiles use Google identity across refresh tokens and cache access only in memory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-antigravity-quota-'))
  const directories = ['one', 'two'].map(name => join(home, name))
  const env = { ANTIGRAVITY_PROFILE_DIRS: directories.join(',') }
  let refreshed = 0
  let users = 0
  let userInfoUnavailable = false
  let accessRejected = false
  const fetcher: typeof fetch = async (input, options) => {
    assert(options?.signal)
    const url = String(input)
    if (url === 'https://oauth2.googleapis.com/token') {
      refreshed++
      assert.match(String(options?.body), /grant_type=refresh_token/)
      return json({ access_token: 'fixture-google-access', expires_in: 3600 })
    }
    if (url.endsWith('/userinfo')) {
      users++
      return userInfoUnavailable ? json({}, 503) : json({ id: 'same-google-person', email: 'person@example.test' })
    }
    if (accessRejected) return json({}, 401)
    assert(url.endsWith('/v1internal:retrieveUserQuotaSummary'))
    return json({ buckets: [{ bucketId: 'gemini-weekly', window: 'weekly',
      remainingFraction: url.includes('daily-') ? 0.8 : 0.4, resetTime: at }] })
  }
  try {
    for (const [index, directory] of directories.entries()) {
      await mkdir(join(directory, 'antigravity-acp'), { recursive: true })
      await writeFile(join(directory, 'antigravity-acp/acp_token.json'), JSON.stringify({
        client_id: 'fixture-client', client_secret: 'fixture-secret', refresh_token: `fixture-refresh-${index}`,
      }))
    }
    const first = await readAntigravityQuotas(env, { home, fetch: fetcher })
    assert.equal(first.accounts.length, 2)
    assert.equal(first.accounts[0]?.accountKey, first.accounts[1]?.accountKey)
    assert.notEqual(first.accounts[0]?.sourceKey, first.accounts[1]?.sourceKey)
    assert.equal(first.accounts[0]?.windows[0]?.remainingPercent, 40)
    assert(!JSON.stringify(first).includes('fixture-refresh'))
    await readAntigravityQuotas(env, { home, fetch: fetcher })
    assert.equal(refreshed, 2)
    assert.equal(users, 2)
    userInfoUnavailable = true
    const refreshedReading = await readAntigravityQuotas(env, {
      home, fetch: fetcher, now: () => Date.now() + 3600_000,
    })
    assert.equal(refreshedReading.accounts[0]?.accountKey, first.accounts[0]?.accountKey,
      'unchanged refresh credentials retain a previously established Google identity after a userinfo outage')
    accessRejected = true
    const beforeRecovery = refreshed
    assert.equal((await readAntigravityQuotas(env, { home, fetch: fetcher })).accounts[0]?.status, 'unavailable')
    accessRejected = false
    const recovered = await readAntigravityQuotas(env, { home, fetch: fetcher })
    assert.equal(refreshed, beforeRecovery + 2, 'rejected cached access is refreshed on the next probe')
    assert.equal(recovered.accounts[0]?.status, 'ready')
    assert.equal(recovered.accounts[0]?.accountKey, first.accounts[0]?.accountKey)
    await rm(join(directories[0]!, 'antigravity-acp/acp_token.json'))
    assert.equal((await readAntigravityQuotas(env, { home, fetch: fetcher })).accounts.length, 1)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('CLIProxyAPI reads every supported account without forwarding tokens or invoking a reset', async () => {
  const env = { NESSIE_CLIPROXY_URL: 'http://127.0.0.1:8317/management.html',
    NESSIE_CLIPROXY_MANAGEMENT_KEY: 'fixture-management-key' }
  const bodies: Record<string, unknown>[] = []
  let failure = 0
  const fetcher: typeof fetch = async (input, options) => {
    assert(String(input).startsWith('http://127.0.0.1:8317/v0/management/'))
    if (failure) return json({}, failure)
    if (String(input).endsWith('/auth-files')) return json({ files: [
      { id: 'one', auth_index: '1', provider: 'codex', email: 'person@example.test',
        id_token: { chatgpt_account_id: 'workspace-one' }, access_token: 'fixture-never-forward' },
      { id: 'two', auth_index: '2', provider: 'claude', email: 'person@example.test' },
      { id: 'off', auth_index: '3', provider: 'codex', disabled: true },
    ] })
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>
    bodies.push(body)
    assert.equal(body.method, 'GET')
    assert(!String(body.url).includes('/consume'))
    const result = String(body.url).endsWith('/rate-limit-reset-credits') ? { credits: [] }
      : String(body.url).includes('anthropic') ? { seven_day: { utilization: 25 } }
        : { plan_type: 'pro', rate_limit: { secondary_window: { used_percent: 40, limit_window_seconds: 604800 } } }
    return json({ status_code: 200, body: JSON.stringify(result) })
  }
  const first = await readCliProxyQuotas(env, { fetch: fetcher })
  assert.equal(first.accounts.length, 2)
  assert.equal(first.accounts[0]?.windows[0]?.remainingPercent, 60)
  assert.equal(first.accounts[1]?.windows[0]?.remainingPercent, 75)
  assert(first.accounts[0]?.workspaceKey)
  assert(!JSON.stringify(first).includes('fixture-never-forward'))
  assert(!JSON.stringify(first).includes('fixture-management-key'))
  assert.equal(bodies.length, 3)
  failure = 503
  const unavailable = await readCliProxyQuotas(env, { fetch: fetcher })
  assert(unavailable.incomplete)
  assert.equal(unavailable.accounts[0]?.status, 'unavailable')
  assert.equal(unavailable.accounts[0]?.checkedAt, first.accounts[0]?.checkedAt)
  failure = 401
  const signedOut = (await readCliProxyQuotas(env, { fetch: fetcher })).accounts[0]
  assert.deepEqual(signedOut?.windows, [])
  assert.equal(signedOut?.resetCredits, undefined)
  assert.deepEqual(await readCliProxyQuotas({}, { fetch: fetcher }), { accounts: [], incomplete: false })
})

test('provider bodies have a hard size bound even when chunked or lacking a content length', async () => {
  const response = boundQuotaResponse(new Response('x'.repeat(256 * 1024 + 1)))
  await assert.rejects(response.text(), /exceeds its limit/)
})

test('one failed provider leaves other readings intact and flags incomplete discovery without leaking diagnostics', async () => {
  const account: ExecutorSubscription = { provider: 'cursor', account: 'person@example.test', plan: null,
    status: 'ready', checkedAt: at, windows: [{ id: 'monthly', kind: 'monthly', remainingPercent: 80, resetsAt: null }] }
  const result = await collectQuotaSources([Promise.resolve({ accounts: [account], incomplete: false }),
    Promise.reject(new Error('fixture-private-credential-diagnostic'))])
  assert.deepEqual(result, { accounts: [account], incomplete: true })
  assert(!JSON.stringify(result).includes('fixture-private'))
})
