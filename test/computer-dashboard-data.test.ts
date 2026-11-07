import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claudeSubscription, codexSubscription } from '../src/provider-subscriptions.js'
import { providerAccountIdentity, readClaudeOrganization } from '../src/provider-account-identity.js'
import { kimiUsageWindows, readKimiQuota } from '../src/provider-process/kimi-quota.js'
import { sysmonGrokSubscription } from '../src/provider-process/grok-quota.js'
import { readQuotaFile } from '../src/provider-process/quota-file.js'
import { readComputerCi } from '../src/computer-ci.js'
import { nvidiaGpuReading, rc6Utilization } from '../src/system-monitor.js'
import { quotaFetch } from '../src/provider-process/quota-fetch.js'
import { startComputerMonitor } from '../src/computer-monitor.js'
import { setImmediate } from 'node:timers/promises'

const at = '2026-11-07T12:00:00.000Z'

test('multi-GPU utilization uses the busiest card while memory sums readable cards independently', () => {
  const reading = nvidiaGpuReading('20, 1024, 4096\n80, 2048, 8192\nN/A, 512, 1024')
  assert.equal(reading.utilization, 80)
  assert.equal(reading.used, 3584 * 1024 ** 2)
  assert.equal(reading.total, 13312 * 1024 ** 2)
  assert.deepEqual(nvidiaGpuReading('N/A, N/A, N/A'), { utilization: null, used: null, total: null })
  assert.equal(rc6Utilization(undefined, { at: 1000, ms: 200 }), null)
  assert.equal(rc6Utilization({ at: 1000, ms: 200 }, { at: 2000, ms: 700 }), 50)
  assert.equal(rc6Utilization({ at: 1000, ms: 200 }, { at: 2000, ms: 100 }), null)
})

test('quota transport rejects arbitrary public, private and redirect endpoints before any dial', async () => {
  for (const url of ['https://example.test/usages', 'http://192.168.1.1/mcp',
    'http://127.0.0.1:7738/mcp?token=bad', 'https://api.kimi.com/coding/v1/usages#other']) {
    await assert.rejects(quotaFetch(url), /endpoint is not supported/)
  }
})

test('transient failures retain a marked last reading but cannot carry an old allowance into another account', async () => {
  let now = Date.parse(at)
  let current = codexSubscription({ account: { email: 'first@example.test' } }, {
    rateLimits: { primary: { usedPercent: 30 } },
  }, at)
  const monitor = startComputerMonitor('unused', { now: () => now, enabled: async () => true,
    sample: async () => ({ capturedAt: at, os: 'windows', processor: 'Test', cpu: null, gpu: null, history: [],
      memoryUsedBytes: 1, memoryTotalBytes: 2, diskUsedBytes: null, diskTotalBytes: null,
      uptimeSeconds: 1, processes: [] }),
    probe: async () => [current], ci: async () => ({ status: 'ready', checkedAt: at, truncated: false, pullRequests: [] }),
  })
  const refresh = async () => {
    monitor.request({ expiresAt: new Date(now + 15_000).toISOString() })
    await setImmediate()
  }
  try {
    monitor.connected(true)
    await refresh()
    assert.equal(monitor.current()?.subscriptions[0]?.windows[0]?.remainingPercent, 70)
    now += 60_000
    current = { ...current, status: 'unavailable', windows: [], checkedAt: new Date(now).toISOString() }
    await refresh()
    assert.equal(monitor.current()?.subscriptions[0]?.checkedAt, at)
    now += 60_000
    current = { ...current, account: 'second@example.test', accountKey: 'new-account' }
    await refresh()
    assert.deepEqual(monitor.current()?.subscriptions[0]?.windows, [])
  } finally { await monitor.stop() }
})

test('T3 provider identities normalize email, separate workspaces and never expose raw identifiers', () => {
  const first = providerAccountIdentity('claude', ' Person@Example.test ', 'organization-a')
  assert.deepEqual(first, providerAccountIdentity('claude', 'person@example.test', 'organization-a'))
  assert.notEqual(first.workspaceKey, providerAccountIdentity('claude', 'person@example.test', 'organization-b').workspaceKey)
  assert.notEqual(first.accountKey, providerAccountIdentity('codex', 'person@example.test', undefined).accountKey)
  assert(!JSON.stringify(first).includes('organization-a'))
  assert.deepEqual(providerAccountIdentity('claude', null, undefined), {})
  const codex = codexSubscription({ account: { email: 'person@example.test' } }, { accountId: 'workspace-a' }, at)
  assert.equal(codex.workspaceKey, providerAccountIdentity('codex', null, 'workspace-a').workspaceKey)
})

test('Claude organisation metadata is bounded and read from its configured CLI directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-claude-identity-'))
  try {
    const path = join(directory, '.claude.json')
    await writeFile(path, JSON.stringify({ oauthAccount: { organizationUuid: 'workspace-a' }, token: 'never-upload' }))
    assert.equal(await readClaudeOrganization({ CLAUDE_CONFIG_DIR: directory }), 'workspace-a')
    assert.equal(await readQuotaFile(path, 5), undefined)
    await writeFile(path, 'malformed')
    assert.equal(await readClaudeOrganization({ CLAUDE_CONFIG_DIR: directory }), undefined)
    assert.equal(await readQuotaFile(directory, 100), undefined)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Claude spend compares the same currency and scale and preserves unknown amounts', () => {
  const parse = (used: unknown, limit: unknown) => claudeSubscription({}, {
    rate_limits: { spend: { enabled: true, used, limit } },
  }, at).windows
  const amount = { amount_minor: 250, currency: 'USD', exponent: 2 }
  assert.equal(parse(amount, { ...amount, amount_minor: 1000 })[0]?.remainingPercent, 75)
  assert.deepEqual(parse(amount, { ...amount, currency: 'EUR' }), [])
  assert.deepEqual(parse({ ...amount, exponent: undefined }, { ...amount, exponent: undefined }), [])
  assert.deepEqual(parse({ ...amount, amount_minor: NaN }, amount), [])
})

test('Kimi keeps weekly quota authoritative and chooses the restrictive short limit', () => {
  const windows = kimiUsageWindows({ usage: { used: '40', limit: '100', resetTime: at }, limits: [
    { window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { used: 20, limit: 100 } },
  ], usages: { limit_5h: { used_ratio: 0.8 }, limit_7d: { used_ratio: 0.99 } } })
  assert.equal(windows[0]?.remainingPercent, 60)
  assert(Math.abs(windows[1]!.remainingPercent - 20) < 0.001)
  assert.equal(windows.length, 2)
  assert.deepEqual(kimiUsageWindows({ usage: { used: false, limit: '100' } }), [])
  assert.deepEqual(kimiUsageWindows({ usage: { used: '', limit: '100' } }), [])
})

test('Kimi reads existing credentials without refreshing and only projects derived usage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-kimi-usage-'))
  let calls = 0
  const request: typeof fetch = async (url, init) => {
    calls++
    assert.equal(url, 'https://api.kimi.com/coding/v1/usages')
    assert.equal(init?.method, 'GET')
    return new Response(JSON.stringify({ usage: { used: 30, limit: 100 } }))
  }
  try {
    assert.equal(await readKimiQuota({}, { home, fetch: request }), null)
    await mkdir(join(home, '.kimi-code/credentials'), { recursive: true })
    await writeFile(join(home, '.kimi-code/credentials/kimi-code.json'), JSON.stringify({ access_token: 'private-test-token',
      expires_at: Date.now() / 1000 + 3600 }))
    const reading = await readKimiQuota({}, { home, fetch: request })
    assert.equal(reading?.windows[0]?.remainingPercent, 70)
    assert(!JSON.stringify(reading).includes('private-test-token'))
    assert.equal(reading?.accountKey, (await readKimiQuota({}, { home, fetch: request }))?.accountKey)
    assert.equal(calls, 2)
    await writeFile(join(home, '.kimi-code/credentials/kimi-code.json'), JSON.stringify({ access_token: 'expired', expires_at: 1 }))
    assert.equal((await readKimiQuota({}, { home, fetch: request }))?.status, 'signed_out')
    assert.equal(calls, 2)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('SysMon Grok projects actual windows without inventing identity or reset', () => {
  const reading = sysmonGrokSubscription({ status: 'live', sampledAt: Date.parse(at), windows: [
    { label: 'Grok 4', used: 25, resetAt: null }, { label: 'unknown', used: null },
  ] }, at)
  assert.equal(reading.account, null)
  assert.equal(reading.windows[0]?.label, 'Grok 4')
  assert.equal(reading.windows[0]?.remainingPercent, 75)
  assert.equal(reading.windows[0]?.resetsAt, null)
  assert.equal(reading.windows.length, 1)
})

test('GitHub failures are bounded, reject foreign URLs and never report malformed results as all clear', async () => {
  const read = (data: unknown) => readComputerCi({ env: {},
    run: async () => ({ code: 0, missing: false, stdout: JSON.stringify(data) }) })
  const good = { html_url: 'https://github.com/example/private/pull/12', title: 'A failing change' }
  assert.equal((await read({ items: [good], total_count: 1 })).pullRequests[0]?.number, 12)
  assert.equal((await read({ items: [], incomplete_results: true })).status, 'unavailable')
  const invalid = await read({ items: [{ ...good, html_url: 'https://example.test/private/pull/12' }] })
  assert.equal(invalid.status, 'unavailable')
  assert.equal(invalid.pullRequests.length, 0)
})
