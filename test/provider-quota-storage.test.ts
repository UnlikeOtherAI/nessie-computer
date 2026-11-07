import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import type { ExecutorSubscription } from '@nessie/executor-protocol'
import { ExecutorMonitorSnapshotSchema } from '@nessie/executor-protocol'
import { readOpenCodeQuota, readOpenCodeStoredKey, openCodeUsageWindows } from '../src/provider-process/opencode-quota.js'
import { claudeResetCredits, codexResetCredits, readClaudeResetCredits } from '../src/provider-process/reset-credit-quota.js'
import { startComputerMonitor } from '../src/computer-monitor.js'

const at = '2026-11-07T12:00:00.000Z'
const now = Date.parse(at)
const later = '2026-11-14T12:00:00.000Z'
type Database = {
  exec: (sql: string) => void; close: () => void
  prepare: (sql: string) => { run: (...values: (string | number | null)[]) => unknown }
}
const sqlite = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => Database
}

test('OpenCode reads only the selected local Console key, without changing the native database', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-opencode-quota-'))
  const directory = join(home, '.local/share/opencode')
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'opencode.db')
  const database = new sqlite.DatabaseSync(file)
  try {
    database.exec('CREATE TABLE credential (id TEXT, integration_id TEXT, active INTEGER, time_created INTEGER, value TEXT)')
    const insert = database.prepare('INSERT INTO credential VALUES (?, ?, ?, ?, ?)')
    insert.run('one', 'opencode', 0, 1, JSON.stringify({ type: 'key', key: 'fixture-retired' }))
    insert.run('two', 'opencode', 1, 2, JSON.stringify({ type: 'key', key: 'fixture-console',
      metadata: { server: 'https://opencode.ai/console/' } }))
    insert.run('three', 'opencode-go', 1, 3, JSON.stringify({ type: 'key', key: 'fixture-go' }))
    const before = await readFile(file)
    assert.equal(readOpenCodeStoredKey(file, 'opencode'), 'fixture-console')
    assert((await readFile(file)).equals(before))
    await writeFile(join(directory, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'fixture-legacy' } }))
    const keys: string[] = []
    const result = await readOpenCodeQuota({}, { home, fetch: async (_input, options) => {
      const key = new Headers(options?.headers).get('authorization')!
      keys.push(key)
      if (key.endsWith('fixture-console')) return new Response('{}', { status: 401 })
      return new Response(JSON.stringify({ usage: {
        rolling: { percent: 80, resetsAt: later }, weekly: { percent: 50, resetsAt: later },
        monthly: { percent: 20, resetsAt: later },
      } }))
    } })
    assert.equal(result?.plan, 'Go')
    assert.deepEqual(result?.windows.map(window => window.remainingPercent), [20, 50, 80])
    assert.deepEqual(keys, ['Bearer fixture-console', 'Bearer fixture-go'])
    assert(!JSON.stringify(result).includes('fixture-go'))
    insert.run('four', 'opencode', 1, 4, JSON.stringify({ type: 'oauth', key: 'fixture-not-a-console-key' }))
    assert.equal(readOpenCodeStoredKey(file, 'opencode'), undefined, 'never fall through a selected OAuth account')
    insert.run('five', 'opencode-go', 1, 5, JSON.stringify({ type: 'key', key: 'fixture-custom',
      metadata: { server: 'https://example.test/console' } }))
    assert.equal(readOpenCodeStoredKey(file, 'opencode-go'), undefined, 'custom Console deployments own their account')
    let requests = 0
    assert.equal(await readOpenCodeQuota({ OPENCODE_SERVER_URL: 'https://example.test' }, {
      home, fetch: async () => { requests++; throw new Error('must not call') },
    }), null)
    assert.equal(requests, 0)
  } finally { database.close(); await rm(home, { recursive: true, force: true }) }
})

test('OpenCode preserves unknown windows and does not label a rejected Zen key as a Go subscription', async () => {
  assert.deepEqual(openCodeUsageWindows({ usage: { weekly: { percent: null, resetsAt: later } } }), [])
  const home = await mkdtemp(join(tmpdir(), 'nessie-opencode-rejected-'))
  try {
    const value = await readOpenCodeQuota({ OPENCODE_API_KEY: 'fixture-zen-key' }, {
      home, fetch: async () => new Response('{}', { status: 403 }),
    })
    assert.equal(value?.status, 'unsupported')
    assert.equal(value?.plan, null)
    assert.deepEqual(value?.windows, [])
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('reset-credit counts retain eligibility, selected grant and expiry without offering redemption', async () => {
  const block = { eligible: true, next_grant_id: 'live', grants: [
    { id: 'live', resets_left: 2, usable_now: true, ends_at: later },
    { id: 'paused', resets_left: 20, usable_now: true, paused: true },
    { id: 'expired', resets_left: 10, usable_now: true, ends_at: at },
    { id: 'unavailable', resets_left: 5, usable_now: false },
  ] }
  assert.deepEqual(claudeResetCredits(block, now), { availableCount: 2, nextExpiresAt: later })
  assert.equal(claudeResetCredits({ ...block, next_grant_id: 'unknown' }, now)?.availableCount, 0)
  assert.equal(claudeResetCredits({ eligible: false }, now), undefined)
  assert.equal(codexResetCredits({ availableCount: null }), undefined)
  assert.deepEqual(codexResetCredits({ availableCount: 1, credits: [
    { status: 'available', expiresAt: Date.parse(later) / 1000 },
  ] }), { availableCount: 1, nextExpiresAt: later })
  const home = await mkdtemp(join(tmpdir(), 'nessie-reset-credits-'))
  const credential = join(home, '.claude/.credentials.json')
  try {
    await mkdir(join(home, '.claude'))
    await writeFile(credential, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-claude-access' } }))
    const before = await readFile(credential)
    let requests = 0
    const fetcher: typeof fetch = async (input, options) => {
      requests++
      assert.equal(String(input), 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1')
      assert.equal(options?.method, undefined, 'the probe is a GET')
      return new Response(JSON.stringify({ cedar_ember: block }))
    }
    assert.equal((await readClaudeResetCredits({}, '2.1.273 (Claude Code)', {
      home, fetch: fetcher, now: () => now, platform: 'win32',
    }))?.availableCount, 2)
    assert((await readFile(credential)).equals(before), 'the CLI credential file is never refreshed or rewritten')
    assert.equal(await readClaudeResetCredits({ CLAUDE_CODE_OAUTH_TOKEN: 'fixture-override' }, '2.1.273', {
      home, fetch: fetcher, platform: 'win32',
    }), undefined, 'do not combine a file account with an explicitly overridden CLI account')
    assert.equal(await readClaudeResetCredits({}, '2.1.273', { home, fetch: fetcher, platform: 'darwin' }), undefined)
    assert.equal(requests, 1)
  } finally { await rm(home, { recursive: true, force: true }) }
})

const subscription = (email: string, source: string, remaining: number): ExecutorSubscription => ({
  provider: 'claude', sourceKey: source, account: email, plan: null, status: 'ready', checkedAt: at,
  windows: [{ id: 'weekly', kind: 'weekly', remainingPercent: remaining, resetsAt: null }],
})
test('multiple accounts of one provider retain only their own source reading, and bounded snapshots report incompleteness', async () => {
  let time = now
  let accounts = [subscription('first@example.test', 'source-one', 80), subscription('second@example.test', 'source-two', 20)]
  const monitor = startComputerMonitor('unused', { now: () => time, enabled: async () => true,
    sample: async () => ({ capturedAt: at, os: 'windows', processor: 'Fixture', cpu: null, gpu: null, history: [],
      memoryUsedBytes: 1, memoryTotalBytes: 2, diskUsedBytes: null, diskTotalBytes: null,
      uptimeSeconds: 1, processes: [] }),
    ci: async () => ({ status: 'ready', checkedAt: at, truncated: false, pullRequests: [] }),
    probe: async () => ({ accounts, incomplete: false }),
  })
  const refresh = async () => {
    monitor.request({ expiresAt: new Date(time + 15_000).toISOString() })
    await setImmediate()
  }
  try {
    monitor.connected(true)
    await refresh()
    time += 60_000
    accounts = [...accounts].reverse().map(value => ({ ...value, status: 'unavailable', windows: [] }))
    await refresh()
    assert.deepEqual(monitor.current()?.subscriptions.map(value => value.windows[0]?.remainingPercent), [20, 80])
    time += 60_000
    accounts = Array.from({ length: 65 }, (_, index) => subscription(`person-${index}@example.test`, `source-${index}`, 50))
    await refresh()
    const snapshot = monitor.current()
    assert.equal(snapshot?.subscriptions.length, 64)
    assert.equal(snapshot?.subscriptionsIncomplete, true)
    ExecutorMonitorSnapshotSchema.parse(snapshot)
    monitor.connected(false)
    assert.equal(monitor.current(), undefined)
  } finally { await monitor.stop() }
})
