import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { ExecutorCodingSessionsFacts } from '@nessie/executor-protocol'

import { CODING_SESSIONS_CONFIG_DIGEST_ENV } from '../src/coding-session/config.js'
import { createCodingSessionsDaemon } from '../src/coding-sessions-daemon.js'
import { createCodingHarness, OWNER_A, OWNER_B, waitUntil } from './coding-session-harness.js'

/**
 * Who may reach a session, and what a replayed command does. The owner key and
 * the command id arrive in reserved `_meta` the model cannot set, so these are
 * structural properties of the bridge, proved over the real subprocess.
 */

test('two owners never see or reach each other\'s sessions', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    const started = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'owner A task' })
    const sessionId = started.body.sessionId as string
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    const listed = await harness.call('session_list', {}, { owner: OWNER_B })
    assert.deepEqual(listed.body.sessions, [])
    for (const [tool, args] of [
      ['session_status', { sessionId }],
      ['session_send', { sessionId, message: 'hijack' }],
      ['session_interrupt', { sessionId }],
      ['session_review', { sessionId }],
      ['session_close', { sessionId }],
    ] as const) {
      const answer = await harness.call(tool, args, { owner: OWNER_B })
      assert.equal(answer.ok, false, tool)
      assert.equal(answer.code, 'coding_session_not_found', tool)
      assert.equal(answer.body.message, 'No such session.')
    }
    const mine = await harness.call('session_status', { sessionId })
    assert.equal(mine.body.status, 'waiting_for_input')
  } finally {
    await harness.cleanup()
  }
})

test('a call without an owner is refused, and close-all belongs to the daemon alone', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    for (const tool of ['session_list', 'session_start']) {
      const answer = await harness.call(tool, tool === 'session_start'
        ? { agent: 'claude', root: 'work', prompt: 'x' }
        : {}, { owner: '' })
      assert.equal(answer.code, 'coding_session_owner_missing', tool)
    }
    const a = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'A' })
    const b = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'B' }, { owner: OWNER_B })
    const refused = await harness.call('session_close_all', { reason: 'lease_ended' })
    assert.equal(refused.code, 'coding_session_daemon_only')
    const closed = await harness.call('session_close_all', { ownerKey: OWNER_A, reason: 'lease_ended' }, { daemon: true, owner: '' })
    assert.equal(closed.body.closing, 1)
    await harness.waitForStatus(a.body.sessionId as string, (body) => body.status === 'closed')
    const other = await harness.waitForStatus(
      b.body.sessionId as string, (body) => body.status === 'waiting_for_input', OWNER_B,
    )
    assert.equal(other.status, 'waiting_for_input')
  } finally {
    await harness.cleanup()
  }
})

test('the daemon\'s close reason is the session\'s own, in its status and in the event that closed it', { timeout: 150_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    const refused = await harness.call('session_close_all', { reason: 'Because the lease ended.' }, { daemon: true, owner: '' })
    assert.equal(refused.code, 'coding_session_invalid_arguments', 'a reason is categorical, never free text')
    // A live Claude process, a Codex turn still running, and a Codex session whose host has already gone.
    const claude = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'claude task' })
    const running = await harness.call('session_start', { agent: 'codex', root: 'work', prompt: '#sleep=60000 codex task' })
    const idle = await harness.call('session_start', { agent: 'codex', root: 'work', prompt: 'short codex task' })
    const sessions = [claude, running, idle].map((answer) => answer.body.sessionId as string)
    await harness.waitForStatus(sessions[0]!, (body) => body.status === 'waiting_for_input')
    await harness.waitForStatus(sessions[1]!, (body) => body.status === 'working')
    await harness.waitForStatus(sessions[2]!, (body) => body.status === 'waiting_for_input')
    const lock = join(harness.stateDir, 'sessions', sessions[2]!, 'host.lock')
    await waitUntil(async () => (existsSync(lock) ? undefined : true), 30_000, 'the idle Codex session\'s host to exit')
    const closed = await harness.call('session_close_all', { ownerKey: OWNER_A, reason: 'access_revoked' }, { daemon: true, owner: '' })
    assert.equal(closed.body.closing, 3)
    for (const sessionId of sessions) {
      const status = await harness.waitForStatus(sessionId, (body) => body.status === 'closed')
      assert.equal(status.reason, 'access_revoked', sessionId)
      const events = await harness.call('session_status', { sessionId, detail: 'events', cursor: '0.0.0' })
      const statuses = (events.body.events as { subtype?: string; status?: string; reason?: string }[])
        .filter((event) => event.subtype === 'status' && event.status === 'closed')
      assert.deepEqual(statuses.map((event) => event.reason), ['access_revoked'], sessionId)
    }
  } finally {
    await harness.cleanup()
  }
})

test('a replayed command id returns the first outcome and does nothing else', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness()
  try {
    const command = randomUUID()
    const args = { agent: 'claude', root: 'work', prompt: 'only once' }
    const first = await harness.call('session_start', args, { command })
    const again = await harness.call('session_start', args, { command })
    assert.equal(again.body.sessionId, first.body.sessionId)
    assert.equal(again.body.replayed, true)
    const sessionId = first.body.sessionId as string
    assert.equal((await harness.call('session_list', {})).body.sessions instanceof Array, true)
    assert.equal(((await harness.call('session_list', {})).body.sessions as unknown[]).length, 1)
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    const send = randomUUID()
    await harness.call('session_send', { sessionId, message: 'follow up once' }, { command: send })
    const replay = await harness.call('session_send', { sessionId, message: 'follow up once' }, { command: send })
    assert.equal(replay.body.replayed, true)
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input' && body.turn === 2)
    const events = await harness.call('session_status', { sessionId, detail: 'events', cursor: '0.0.0' })
    const echoed = (events.body.events as { kind: string; text?: string }[])
      .filter((event) => event.kind === 'user' && event.text === 'follow up once')
    assert.equal(echoed.length, 1)
    const stolen = await harness.call('session_send', { sessionId, message: 'x' }, { command: send, owner: OWNER_B })
    assert.equal(stolen.code, 'coding_session_not_found')
  } finally {
    await harness.cleanup()
  }
})

test('each owner gets the configured number of live sessions', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({ codingSessions: { maxLiveSessionsPerOwner: 1 } })
  try {
    const first = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'one' })
    assert.equal(first.ok, true)
    const second = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'two' })
    assert.equal(second.code, 'coding_session_quota_exceeded')
    const otherOwner = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'three' }, { owner: OWNER_B })
    assert.equal(otherOwner.ok, true)
    await harness.call('session_close', { sessionId: first.body.sessionId })
    await harness.waitForStatus(first.body.sessionId as string, (body) => body.status === 'closed')
    assert.equal((await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'four' })).ok, true)
  } finally {
    await harness.cleanup()
  }
})

test('a ticket\'s sessions are their own owner: a lease-end close misses them, and each ticket has its own quota', {
  timeout: 150_000,
}, async () => {
  const harness = await createCodingHarness({ codingSessions: { maxLiveSessionsPerOwner: 1 }, reviewedDigest: true })
  // The daemon over the harness's own bridge, so the keys are the ones it derives from a stamped owner.
  const facts: ExecutorCodingSessionsFacts = {
    serverName: 'coding-sessions', agents: ['claude', 'codex'], permissionMode: { claude: 'default', codex: 'default' },
    allowedToolCount: 0, environmentNames: [], rootNames: ['work'],
    configDigest: harness.server.env![CODING_SESSIONS_CONFIG_DIGEST_ENV]!,
  }
  const daemon = createCodingSessionsDaemon({
    executorId: randomUUID(), facts, servers: [harness.server], sessions: harness.manager, log: () => undefined,
  })
  const person = { agentId: randomUUID(), actorUserId: randomUUID() }
  const keyFor = (owner: { agentId: string; actorUserId: string; contextId?: string }): string => {
    const meta = daemon.callMeta('coding-sessions', { commandId: randomUUID(), owner })
    return meta?.['nessie/owner'] as string
  }
  const own = keyFor(person)
  const ticketA = keyFor({ ...person, contextId: `ticket:${randomUUID()}:${randomUUID()}` })
  const ticketB = keyFor({ ...person, contextId: `ticket:${randomUUID()}:${randomUUID()}` })
  assert.equal(new Set([own, ticketA, ticketB]).size, 3)
  const start = (owner: string, prompt: string) => harness.call('session_start', { agent: 'claude', root: 'work', prompt }, { owner })
  try {
    const mine = await start(own, 'the person\'s own task')
    const first = await start(ticketA, 'NES-140 fix the pricing page')
    const second = await start(ticketB, 'NES-141 fix the login page')
    for (const answer of [mine, first, second]) assert.equal(answer.ok, true, JSON.stringify(answer.body))
    // The quota of one is per full owner key: the person's own session does not use up a ticket's.
    assert.equal((await start(own, 'another own task')).code, 'coding_session_quota_exceeded')
    assert.equal((await start(ticketA, 'NES-140 again')).code, 'coding_session_quota_exceeded')
    assert.deepEqual(((await harness.call('session_list', {}, { owner: ticketA })).body.sessions as { sessionId: string }[])
      .map((session) => session.sessionId), [first.body.sessionId], 'a ticket lists its own sessions only')
    // The person's last lease ends: the control plane asks for their key without a context.
    await daemon.close([{ ownerKey: own, reason: 'lease_ended' }])
    await harness.waitForStatus(mine.body.sessionId as string, (body) => body.status === 'closed', own)
    for (const [sessionId, owner] of [[first.body.sessionId, ticketA], [second.body.sessionId, ticketB]] as const) {
      const status = await harness.waitForStatus(sessionId as string, (body) => body.status === 'waiting_for_input', owner)
      assert.equal(status.status, 'waiting_for_input', 'the ticket\'s session is untouched')
    }
  } finally {
    await harness.cleanup()
  }
})

test('a configuration that differs from its reviewed digest starts no host', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({ bridgeEnv: { NESSIE_CODING_SESSIONS_CONFIG_DIGEST: `sha256:${'0'.repeat(64)}` } })
  try {
    const answer = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'x' })
    assert.equal(answer.code, 'coding_session_config_changed')
    assert.deepEqual(await readdir(join(harness.stateDir, 'sessions')), [])
    // Nothing an unreviewed file names is read or reported; stopping things still works.
    assert.equal((await harness.call('session_list', {})).code, 'coding_session_config_changed')
    assert.equal((await harness.call('session_status', { sessionId: '0f0e0d0c-0b0a-4908-8706-050403020100' })).code, 'coding_session_config_changed')
    assert.deepEqual((await harness.call('session_close_all', { reason: 'test' }, { daemon: true, owner: '' })).body, { closing: 0 })
  } finally {
    await harness.cleanup()
  }
})

test('the agent inherits a login-like environment without the parent session\'s coupling', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({
    bridgeEnv: { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_GIT_BASH_PATH: 'kept-by-pass' },
    agentEnv: { inheritUserSession: true, pass: ['CLAUDE_CODE_GIT_BASH_PATH'] },
    reviewedDigest: true,
  })
  try {
    const started = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: '#env report' })
    await harness.waitForStatus(started.body.sessionId as string, (body) => body.status === 'waiting_for_input')
    const dump = (await readdir(harness.recordDir)).find((name) => name.startsWith('env-'))!
    const env = JSON.parse(await readFile(join(harness.recordDir, dump), 'utf8')) as Record<string, string>
    const get = (name: string): string | undefined => Object.entries(env)
      .find(([key]) => (process.platform === 'win32' ? key.toUpperCase() === name.toUpperCase() : key === name))?.[1]
    assert.equal(get('CLAUDECODE'), undefined)
    assert.equal(get('CLAUDE_CODE_ENTRYPOINT'), undefined)
    assert.equal(get('CLAUDE_CODE_DISABLE_AUTO_MEMORY'), '1')
    assert.equal(get('CLAUDE_CODE_GIT_BASH_PATH'), 'kept-by-pass')
    assert.equal(get('SCRIPTED_SET'), 'from-config')
    assert.equal(get('NESSIE_EXECUTOR_PACKAGED_CLI'), undefined)
    // The reviewed digest matched (the session ran) and describes the executor, not the person.
    assert.equal(get('NESSIE_CODING_SESSIONS_CONFIG_DIGEST'), undefined)
    if (process.platform === 'win32') {
      // None of these is in the MCP SDK's minimal environment; the registry and the logon supply them.
      for (const name of ['PATHEXT', 'ComSpec', 'windir', 'ProgramData', 'TMP']) assert.ok(get(name), name)
    } else {
      assert.ok(get('HOME'))
      assert.ok(get('SHELL') ?? get('LOGNAME'))
    }
  } finally {
    await harness.cleanup()
  }
})

test('a root that overlaps the coding-sessions state stops the bridge from starting', { timeout: 60_000 }, async () => {
  const harness = await createCodingHarness({ rootsInsideState: true })
  try {
    const answer = await harness.call('session_list', {})
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'EXECUTOR_MCP_UNAVAILABLE')
  } finally {
    await harness.cleanup()
  }
})
