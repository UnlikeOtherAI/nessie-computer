import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import test from 'node:test'
import { ExecutorMonitorSnapshotSchema, ExecutorSessionConversationSchema } from '@nessie/executor-protocol'
import { codexSubscription, claudeSubscription } from '../src/provider-subscriptions.js'
import { listSavedClaudeSessions } from '../src/existing-session/claude-saved.js'
import { readNativeTranscript } from '../src/existing-session/transcript.js'
import { createSystemMonitor } from '../src/system-monitor.js'
import { readSessionConversation } from '../src/coding-session/session-view.js'
import { codingSessionPaths } from '../src/coding-session/session-files.js'

test('provider windows use reported utilization and duration, with unknown limits left unknown', () => {
  const at = new Date().toISOString()
  const codex = codexSubscription({ account: { type: 'chatgpt', email: 'person@example.test', planType: 'promax' } }, {
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 78, windowDurationMins: 10080, resetsAt: 1794000000 },
      secondary: { usedPercent: -1 } }, model: { primary: { usedPercent: 10 } } },
  }, at)
  assert.equal(codex.plan, 'promax')
  const exhausted = codexSubscription({ account: {} }, { rateLimits: { primary: {
    usedPercent: 125, resetsAt: 1e30, windowDurationMins: Infinity,
  } }, rateLimitsByLimitId: { model: { primary: { usedPercent: 5 } } } }, at)
  assert.equal(exhausted.windows[0]?.remainingPercent, 0)
  assert.equal(exhausted.windows[0]?.resetsAt, null)
  assert.deepEqual(codex.windows.map((item) => [item.kind, item.remainingPercent]), [['weekly', 22], ['other', 90]])
  assert.equal(codexSubscription({ account: null }, null, at).status, 'signed_out')
  assert.deepEqual(codexSubscription({ account: { planType: 'pro' } }, null, at).windows, [])
  const claude = claudeSubscription({ account: { email: 'person@example.test', subscriptionType: 'Claude Ultra' } }, {
    rate_limits_available: true, rate_limits: { five_hour: { utilization: 45, resets_at: null },
      seven_day: { utilization: 100 }, model_scoped: [{ display_name: 'Fable', utilization: 23 }],
      extra_usage: { is_enabled: true, used_credits: 100, monthly_limit: 400 } },
  }, at)
  assert.deepEqual(claude.windows.map((item) => item.remainingPercent), [55, 0, 77, 75])
  assert.equal(claude.windows[0]?.resetsAt, null)
})

test('saved Claude discovery and transcript reads preserve native identity, tools and truncation', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nessie-native-history-')))
  const id = randomUUID()
  const other = randomUUID()
  const project = join(dir, 'projects', 'repo')
  await mkdir(project, { recursive: true })
  const file = join(project, `${id}.jsonl`)
  const row = (value: Record<string, unknown>) => JSON.stringify({ sessionId: id, cwd: dir, ...value }) + '\n'
  try {
    await writeFile(file, row({ type: 'user', message: { content: 'Oprav to prosím' } })
      + row({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working' },
        { type: 'tool_use', name: 'Read', input: { file: 'README.md' } }] } })
      + row({ sessionId: other, type: 'user', message: { content: 'WRONG_SESSION' } })
      + row({ type: 'user', isMeta: true, message: { content: 'INTERNAL' } }))
    const saved = await listSavedClaudeSessions(dir)
    assert.equal(saved.length, 1)
    assert.equal(saved[0]?.session.title, 'Oprav to prosím')
    assert.equal(saved[0]?.session.status, 'unknown')
    const history = await readNativeTranscript('claude', join(dir, 'projects'), file, id)
    assert.equal(history?.messages.length, 2)
    assert.deepEqual(await readNativeTranscript('claude', join(dir, 'projects'), toNamespacedPath(file), id), history)
    assert.equal(history?.messages[1]?.parts[1]?.kind, 'tool_call')
    const firstId = history?.messages[0]?.id
    await writeFile(file, row({ type: 'user', message: { content: 'Oprav to prosím' } })
      + Array.from({ length: 250 }, (_, index) => row({ type: 'assistant', message: { content: `Reply ${index}` } })).join(''))
    const recent = await readNativeTranscript('claude', join(dir, 'projects'), file, id)
    assert.equal(recent?.messages.length, 200)
    assert.equal(recent?.truncated, true)
    assert.notEqual(recent?.messages[0]?.id, firstId)
    assert.equal(await readNativeTranscript('claude', join(dir, 'elsewhere'), file, id), null)
    const old = new Date(Date.now() - 31 * 86400_000)
    await utimes(file, old, old)
    assert.equal((await listSavedClaudeSessions(dir)).length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the real supported sampler returns measured capacities without provider credentials', async () => {
  const snapshot = await createSystemMonitor()()
  ExecutorMonitorSnapshotSchema.parse({ ...snapshot, subscriptions: [] })
  assert(snapshot.memoryTotalBytes > 0)
  assert(snapshot.memoryUsedBytes <= snapshot.memoryTotalBytes)
  assert(snapshot.processes.length <= 10)
  assert(snapshot.uptimeSeconds > 0)
})

test('viewing managed conversation does not consume the agent cursor or create requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-conversation-view-'))
  const id = randomUUID()
  const paths = codingSessionPaths(dir, id)
  await mkdir(paths.dir, { recursive: true })
  const cursor = join(paths.dir, 'delivered.json')
  try {
    await writeFile(paths.events, JSON.stringify({ seq: 1, at: new Date().toISOString(), kind: 'user', text: 'hello' }) + '\n')
    await writeFile(cursor, 'unchanged')
    const view = await readSessionConversation(paths, { version: 1, sessionId: id, ownerKey: 'owner-12345678',
      agent: 'codex', rootName: 'work', path: '.', title: 'Test', createdAt: new Date().toISOString() })
    ExecutorSessionConversationSchema.parse(view)
    assert.equal(view?.messages[0]?.parts[0]?.text, 'hello')
    assert.equal(await readFile(cursor, 'utf8'), 'unchanged')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
