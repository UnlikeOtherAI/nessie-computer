import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { EXECUTOR_CODING_SESSION_REPORT_MAXIMUM } from '@nessie/executor-protocol'

import { openFirst } from '../src/coding-session/session-report.js'
import { ExistingCodex } from '../src/existing-session/codex.js'
import { ExistingSessions } from '../src/existing-session/manager.js'
import { existingSessionsEnabled } from '../src/existing-session/settings.js'
import { existingSessionId, type ExistingSession } from '../src/existing-session/types.js'

const NATIVE = '11111111-1111-4111-a111-111111111111'
const nativeRow = { id: NATIVE, name: 'Same title', cwd: '/same/repo', updatedAt: 1_790_000_000, source: 'vscode' }

test('Codex reports a thread running only when its own runtime status says so', async () => {
  const ids = ['22222222-2222-4222-a222-222222222222', '33333333-3333-4333-a333-333333333333', NATIVE]
  const statuses = [{ type: 'active', activeFlags: [] }, { type: 'idle' }, { type: 'notLoaded' }]
  const codex = new ExistingCodex({ path: '/fake/codex', version: 'test' }, { CODEX_HOME: '/profile-a' }, {
    close: () => undefined,
    call: async (method) => method === 'thread/list'
      ? { data: ids.map((id, index) => ({ ...nativeRow, id, status: statuses[index] })) } : { data: [] },
  })
  assert.deepEqual((await codex.list()).map((row) => row.status), ['working', 'waiting_for_input', 'unknown'])
})

test('a session report puts open sessions first, so the cap only drops ended or saved ones', () => {
  const ended = Array.from({ length: 40 }, (_, index) => ({ id: `ended-${index}`, status: 'closed' }))
  const report = openFirst([...ended, { id: 'saved', status: 'unknown' }, { id: 'live', status: 'working' }])
  assert.equal(report.length, EXECUTOR_CODING_SESSION_REPORT_MAXIMUM)
  assert.deepEqual(report.slice(0, 2).map((row) => row.id), ['live', 'ended-0'])
})

test('Codex uses native queue without loading or resuming the original conversation', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const codex = new ExistingCodex({ path: '/fake/codex', version: 'test' }, { CODEX_HOME: '/profile-a' }, {
    close: () => undefined,
    call: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/list') return { data: [nativeRow] }
      if (method === 'thread/read') return { thread: { ...nativeRow, turns: [] } }
      return { data: [] }
    },
  })
  const [session] = await codex.list()
  assert.equal(session?.status, 'unknown', 'persisted metadata never proves an idle runtime')
  assert.equal(session?.capabilities.queue, true)
  await codex.read(session!, false)
  const result = await codex.queue(session!, 'Nessie instruction', NATIVE)
  assert.equal(result.state, 'queued_natively')
  assert.deepEqual(calls.map((call) => call.method), [
    'thread/list', 'thread/queue/list', 'thread/read', 'thread/queue/add',
  ])
  assert.equal(calls[0]!.params.useStateDbOnly, true, 'never scan unbounded rollout history for inventory')
  assert.equal(calls[2]!.params.includeTurns, false)
  assert.equal(calls[3]!.params.threadId, NATIVE)
  assert.equal(calls[3]!.params.clientUserMessageId, NATIVE)
  assert.match(String(result.behavior), /during its current turn/u)
})

test('same title and repository cannot alias native sessions or provider profiles', () => {
  assert.notEqual(existingSessionId('codex', '/a', NATIVE), existingSessionId('codex', '/b', NATIVE))
  assert.notEqual(existingSessionId('claude', '/a', NATIVE), existingSessionId('codex', '/a', NATIVE))
  assert.notEqual(existingSessionId('codex', '/a', randomUUID()), existingSessionId('codex', '/a', NATIVE))
  assert.equal(existingSessionId('codex', '/a', NATIVE), existingSessionId('codex', '/a', NATIVE))
})

test('renaming a discovered native session preserves its ID and sends to that exact conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-session-rename-'))
  const otherId = randomUUID()
  let title = 'Original title'
  const queued: unknown[] = []
  const codex = new ExistingCodex({ path: '/fake/codex', version: 'test' }, { CODEX_HOME: '/profile-a' }, {
    close: () => undefined,
    call: async (method, params) => {
      if (method === 'thread/list') return { data: [
        { ...nativeRow, id: otherId, name: 'Original title' }, { ...nativeRow, name: title },
      ] }
      if (method === 'thread/read') return { thread: { ...nativeRow, name: title, turns: [] } }
      if (method === 'thread/queue/add') queued.push(params.threadId)
      return { data: [] }
    },
  })
  const manager = new ExistingSessions(directory, async () => ({ codex }))
  try {
    const original = (await manager.list()).find((row) => row.nativeId === NATIVE)!
    title = 'Přejmenovaná konverzace'
    const refreshed = (await manager.list(true)).find((row) => row.nativeId === NATIVE)!
    assert.equal(refreshed.title, title)
    assert.equal(refreshed.sessionId, original.sessionId)
    await manager.send('queue', original.sessionId, 'continue here', 'owner-a-123456789', randomUUID())
    assert.deepEqual(queued, [NATIVE], 'the other conversation kept the old title but never receives the input')
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a provider without native queue support remains inspectable and cannot advertise queue', async () => {
  const codex = new ExistingCodex({ path: '/fake/codex', version: 'older' }, {}, {
    close: () => undefined, call: async (method) => {
      if (method === 'thread/list') return { data: [nativeRow] }
      throw new Error('Unknown method')
    },
  })
  const [session] = await codex.list()
  assert.equal(session?.capabilities.queue, false)
  await assert.rejects(codex.queue(session!, 'do work', NATIVE), /unavailable/u)
})

test('default-on discovery, disable, idempotent dispatch and unknown outcomes preserve external sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-existing-'))
  let writes = 0
  let detached = 0
  const session: ExistingSession = { sessionId: existingSessionId('codex', '/a', NATIVE), nativeId: NATIVE,
    provider: 'codex', title: 'Same title', cwd: '/same/repo', client: 'unknown', status: 'unknown',
    updatedAt: new Date().toISOString(), capabilities: { queue: true, push: false, steer: false, interrupt: false,
      reason: 'Native experimental input' } }
  const manager = new ExistingSessions(directory, async () => ({ codex: {
    nextCursor: null, program: { path: '/fake/codex', version: 'test' }, list: async () => [session],
    read: async () => session, close: () => { detached += 1 }, queue: async () => {
      writes += 1
      throw new Error('Connection lost after provider accepted input')
    },
  } }))
  try {
    assert.equal(await existingSessionsEnabled(directory), true)
    assert.equal((await manager.list()).length, 1)
    const command = randomUUID()
    const first = await manager.send('queue', session.sessionId, 'Do this', 'owner-a-123456789', command)
    assert.equal(first.state, 'outcome_unknown')
    assert.deepEqual(await manager.send('queue', session.sessionId, 'Do this', 'owner-a-123456789', command), first)
    assert.equal(writes, 1, 'ambiguous writes are never blindly retried')
    await assert.rejects(manager.send('queue', session.sessionId, 'Different', 'owner-a-123456789', command), /already used/u)
    await assert.rejects(manager.send('steer', session.sessionId, 'Do this', 'owner-a-123456789', randomUUID()), /Native/u)
    await writeFile(join(directory, 'existing-coding-sessions.json'), JSON.stringify({ enabled: false }))
    assert.deepEqual(await manager.list(), [])
    await assert.rejects(manager.send('queue', session.sessionId, 'Do this', 'owner-a-123456789', randomUUID()), /disabled/u)
    assert.equal(writes, 1)
    assert.ok(detached > 0, 'disable detaches the metadata connection; no process-control API is available')
    await writeFile(join(directory, 'existing-coding-sessions.json'), '{malformed')
    assert.equal(await existingSessionsEnabled(directory), false)
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }) }
})

test('Claude delivery receipts survive restart and never turn a transport write into consumption', async () => {
  const { deliverOnce, latestExistingDelivery } = await import('../src/existing-session/delivery.js')
  const { channelInboxDir } = await import('../src/existing-session/channel-files.js')
  const { mkdir } = await import('node:fs/promises')
  const directory = await mkdtemp(join(tmpdir(), 'nessie-delivery-'))
  const sessionId = randomUUID()
  const commandId = randomUUID()
  let eventId = ''
  let writes = 0
  const input = { stateDir: directory, sessionId, commandId, ownerKey: 'owner-123', action: 'push', message: 'hello',
    send: async (id: string) => { writes += 1; eventId = id; return { state: 'accepted_locally', providerMessageId: commandId } } }
  try {
    assert.equal((await deliverOnce(input)).state, 'accepted_locally')
    const inbox = channelInboxDir(directory, sessionId)
    await mkdir(inbox, { recursive: true })
    await writeFile(join(inbox, `${eventId}.result`), JSON.stringify({
      state: 'written_to_transport', providerMessageId: commandId,
    }))
    assert.equal((await latestExistingDelivery(directory, sessionId))?.state, 'written_to_transport')
    assert.equal((await deliverOnce(input)).state, 'written_to_transport')
    assert.equal(writes, 1)
    await assert.rejects(deliverOnce({ ...input, message: 'changed' }), /already used/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a definitive native queue rejection is failed, while secret projection preserves opaque IDs', async () => {
  const { deliverOnce } = await import('../src/existing-session/delivery.js')
  const { CodexOperationRejected } = await import('../src/existing-session/codex-rpc.js')
  const { createExistingProjection } = await import('../src/existing-session/projection.js')
  const directory = await mkdtemp(join(tmpdir(), 'nessie-rejected-'))
  try {
    const result = await deliverOnce({ stateDir: directory, sessionId: randomUUID(), commandId: randomUUID(),
      ownerKey: 'owner-123', action: 'queue', message: 'hello', send: async () => {
        throw new CodexOperationRejected('Codex rejected the input.')
      } })
    assert.equal(result.state, 'failed')
    const identity = (value: string): string => value
    const project = createExistingProjection({ rewrite: identity, rewritePaths: identity, rewriteBranch: identity })
    const value = { sessionId: NATIVE, title: 'secret ghp_123456789012345678901234567890',
      recentMessages: [{ role: 'assistant', text: 'API_KEY=supersecretvalue' }] }
    const scrubbed = project(value)
    assert.equal(scrubbed.sessionId, NATIVE)
    assert.equal(scrubbed.title, 'secret <secret>')
    assert.equal(scrubbed.recentMessages[0]?.text, 'API_KEY=<secret>')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('background inventory requires live private-machine authority and stops at revocation', async () => {
  const { existingAuthorityWriter } = await import('../src/existing-session/authority.js')
  const directory = await mkdtemp(join(tmpdir(), 'nessie-inventory-authority-'))
  let reads = 0
  const manager = new ExistingSessions(directory, async () => { reads += 1; return {} })
  const writer = existingAuthorityWriter(directory)
  try {
    assert.deepEqual(await manager.inventory(), [])
    assert.equal(reads, 0, 'no provider starts before a usable private-machine heartbeat')
    await writer(false)
    assert.deepEqual(await manager.inventory(), [])
    assert.equal(reads, 0, 'shared scope never starts native discovery')
    await writer(true)
    await manager.inventory()
    await manager.inventory()
    assert.equal(reads, 1)
    await writer(false)
    assert.deepEqual(await manager.inventory(), [])
    await writeFile(join(directory, 'existing-session-authority.json'), JSON.stringify({ expiresAt: Date.now() - 1 }))
    assert.deepEqual(await manager.inventory(), [])
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }) }
})
