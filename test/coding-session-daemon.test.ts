import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  canonicalExecutorJson,
  type ExecutorCodingSessionsFacts,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { ExecutorApiError, executorApi } from '../src/api-client.js'
import { CODING_SESSIONS_CONFIG_DIGEST_ENV, codingSessionsConfigDigest, normalizeCodingSessionsConfig } from '../src/coding-session/config.js'
import {
  codingSessionOwnerKey,
  createCodingSessionsDaemon,
  DISCONNECT_CLOSE_MS,
  withDaemonSupervisor,
} from '../src/coding-sessions-daemon.js'
import { ownerRequestsLeaseIsLive } from '../src/coding-session/owner-requests-lease.js'
import { executeExecutorCommand, heartbeatExecutor } from '../src/daemon.js'
import { createLocalMcpReporter } from '../src/local-mcp-report.js'
import type { ExecutorLocalMcpServer } from '../src/mcp-servers.js'
import { createExecutorMcpSessionManager, type ExecutorMcpSessionManager } from '../src/mcp-session-manager.js'
import type { ExecutorLocalState } from '../src/state-store.js'

/**
 * The daemon's half of coding-sessions.md §3 and §5: the reserved `_meta` it
 * stamps on calls to the built-in bridge and on no other server, and the
 * teardown calls it makes. The stamping is proved over a real MCP server
 * process that echoes the `_meta` it received; the teardown over a recording
 * session manager, since what matters there is which calls the daemon makes.
 */

const SCRIPT = fileURLToPath(new URL('./fixtures/scripted-mcp-server.mjs', import.meta.url))
const executorId = '00000000-0000-4000-8000-000000000801'
const agentId = '00000000-0000-4000-8000-000000000802'
const actorUserId = '00000000-0000-4000-8000-000000000803'
const runId = '00000000-0000-4000-8000-000000000804'
const digest = `sha256:${'c'.repeat(64)}`
const pairingSource = { kind: 'unbound_local' as const, executorId,
  acceptedPairing: { kind: 'code' as const, id: '00000000-0000-4000-8000-000000000806' },
  machinePublicKeyDigest: 'a'.repeat(64) }
const rules = { mode: 'allowlist' as const, allowlist: ['claude *'], denylist: ['git push *'] }
/** The daemon reads the rules as it stamps each call. */
const commandRules = () => rules

const facts: ExecutorCodingSessionsFacts = {
  serverName: 'coding-sessions', agents: ['claude'], permissionMode: { claude: 'acceptEdits' },
  allowedToolCount: 0, environmentNames: [], rootNames: ['nessie'], configDigest: digest,
}

const bridgeSpec = (configPath = join(tmpdir(), 'coding-sessions.json'), command = [process.execPath, SCRIPT]) => ({
  name: 'coding-sessions',
  command: [...command, 'serve-coding-session-mcp', '--config', configPath],
  env: { [CODING_SESSIONS_CONFIG_DIGEST_ENV]: digest, NESSIE_TEST_MCP_MODE: 'ok' },
}) satisfies ExecutorLocalMcpServer

const otherSpec: ExecutorLocalMcpServer = { name: 'kelpie', command: [process.execPath, SCRIPT], env: { NESSIE_TEST_MCP_MODE: 'ok' } }

const envelope = (commandId: string, payload: Record<string, unknown>): ExecutorCommandEnvelope => ({
  argumentDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}` as never,
  bindingFence: '1',
  bindingId: '00000000-0000-4000-8000-000000000805' as never,
  capabilityRevision: 3,
  commandId: commandId as never,
  expiresAt: '2099-01-01T00:00:00.000Z',
  idempotencyKey: commandId,
  operationKey: 'mcp.call',
  payload,
})

const stateWith = (servers: ExecutorLocalMcpServer[]): ExecutorLocalState => ({
  apiBaseUrl: 'https://api.example.test',
  descriptor: {
    codingSessions: facts,
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    mcpServers: servers.map((server) => server.name).sort(),
    operationKeys: ['mcp.tools', 'mcp.call'], profiles: ['workspace_sandbox'], revision: 3,
  },
  executorId, machinePrivateKey: 'private', machinePublicKey: 'public',
  mcpServers: servers, workspaceFolders: [{ name: 'docs', path: tmpdir() }],
})

type Echo = { echoed: Record<string, unknown> | null; meta: Record<string, unknown> | null }

const echoOf = (result: Record<string, unknown>): Echo => {
  assert.equal(result.success, true, JSON.stringify(result))
  return JSON.parse((result as { content: { text: string }[] }).content[0]!.text) as Echo
}

test('owner, command id and command rules reach the built-in bridge as reserved _meta, and no other server', async () => {
  const servers = [bridgeSpec(), otherSpec]
  const state = stateWith(servers)
  const mcpSessions = createExecutorMcpSessionManager(servers, { maxResultBytes: 65_536 }, { log: () => undefined })
  const codingBridge = createCodingSessionsDaemon({
    executorId, pairingSource: () => pairingSource, commandRules, facts, servers, sessions: mcpSessions,
  })
  const run = (commandId: string, payload: Record<string, unknown>) => executeExecutorCommand(
    tmpdir(), state, envelope(commandId, payload), { mcpSessions, codingBridge },
  )
  const owner = { agentId, actorUserId }
  const modelArguments = { sessionId: 'x', 'nessie/owner': 'forged-by-the-model', nested: { keep: [1, 2] } }
  try {
    const toBridge = echoOf(await run('command-a', {
      args: { server: 'coding-sessions', tool: 'echo', arguments: modelArguments }, owner, runId,
    }))
    const ownerKey = `sha256:${createHash('sha256').update(`${executorId}|${agentId}|${actorUserId}`).digest('hex')}`
    assert.equal(codingSessionOwnerKey(executorId, owner), ownerKey)
    assert.deepEqual(toBridge.meta, {
      'nessie/command': 'command-a', 'nessie/owner': ownerKey, 'nessie/command-rules': rules,
      'nessie/session-pairing-source': pairingSource,
    }, 'the rules this daemon runs under decide what a terminal may start')
    assert.deepEqual(toBridge.echoed, modelArguments, 'the model\'s arguments pass through untouched')

    const toOther = echoOf(await run('command-b', {
      args: { server: 'kelpie', tool: 'echo', arguments: modelArguments }, owner, runId,
    }))
    assert.equal(toOther.meta, null, 'no other server learns who is calling')
    assert.deepEqual(toOther.echoed, modelArguments)

    const unowned = echoOf(await run('command-c', { args: { server: 'coding-sessions', tool: 'echo' }, runId }))
    assert.deepEqual(unowned.meta, { 'nessie/command': 'command-c', 'nessie/command-rules': rules,
      'nessie/session-pairing-source': pairingSource },
      'without a stamped owner the bridge refuses')

    for (const payload of [
      { args: { server: 'coding-sessions', tool: 'echo', owner }, runId },
      { args: { server: 'coding-sessions', tool: 'echo' }, owner: { agentId }, runId },
      { args: { server: 'coding-sessions', tool: 'echo' }, runId, _meta: { 'nessie/daemon-control': true } },
    ]) {
      // The refusal names the field (mcp-dispatch.ts), and nothing reaches a server.
      const refused = await run('command-d', payload)
      assert.equal(refused.code, 'EXECUTOR_COMMAND_ARGUMENTS_INVALID')
      assert.equal(refused.success, false)
      assert.ok(Array.isArray(refused.fields) && refused.fields.length > 0, JSON.stringify(refused))
    }
  } finally {
    await mcpSessions.stopAll()
  }
})

test('a ticket context is part of the owner key, and without one the key is the one every session already has', async () => {
  // The same vectors as the schemas' owner-key text test and executor-manage's
  // key test: the daemon and the control plane derive one key, on every OS.
  const contextId = 'ticket:00000000-0000-4000-8000-000000000901:00000000-0000-4000-8000-000000000902'
  const plain = 'sha256:8b525e6e91d92c5ccdddcd9d9956f71fa0438b1b29371c92103c743f1fe5689c'
  const ticket = 'sha256:bf37fb2ab3d3d9b845cce071a239f1676a5c1bd29fbd1f7e6805781e04b50187'
  assert.equal(codingSessionOwnerKey(executorId, { agentId, actorUserId }), plain)
  assert.equal(codingSessionOwnerKey(executorId, { agentId, actorUserId, contextId }), ticket)
  const servers = [bridgeSpec()]
  const mcpSessions = createExecutorMcpSessionManager(servers, { maxResultBytes: 65_536 }, { log: () => undefined })
  const codingBridge = createCodingSessionsDaemon({
    executorId, pairingSource: () => pairingSource, commandRules, facts, servers, sessions: mcpSessions,
  })
  const run = (commandId: string, payload: Record<string, unknown>) => executeExecutorCommand(
    tmpdir(), stateWith(servers), envelope(commandId, payload), { mcpSessions, codingBridge },
  )
  const args = { server: 'coding-sessions', tool: 'echo', arguments: {} }
  try {
    const withContext = echoOf(await run('command-t1', { args, owner: { agentId, actorUserId, contextId }, runId }))
    assert.deepEqual(withContext.meta, { 'nessie/command': 'command-t1', 'nessie/owner': ticket,
      'nessie/command-rules': rules, 'nessie/session-pairing-source': pairingSource })
    const without = echoOf(await run('command-t2', { args, owner: { agentId, actorUserId }, runId }))
    assert.deepEqual(without.meta, { 'nessie/command': 'command-t2', 'nessie/owner': plain,
      'nessie/command-rules': rules, 'nessie/session-pairing-source': pairingSource })
    // A context in any other spelling never becomes a key: the envelope refuses it by name.
    const refused = await run('command-t3', { args, owner: { agentId, actorUserId, contextId: contextId.toUpperCase() }, runId })
    assert.equal(refused.code, 'EXECUTOR_COMMAND_ARGUMENTS_INVALID')
    assert.deepEqual(refused.fields, ['owner.contextId'])
  } finally {
    await mcpSessions.stopAll()
  }
})

test('the bridge alone is started with the daemon\'s supervisor marker, which the SDK would drop', () => {
  const [bridge, other] = withDaemonSupervisor([bridgeSpec(), otherSpec], { NESSIE_EXECUTOR_SUPERVISOR: 'service' })
  assert.equal(bridge!.env?.NESSIE_EXECUTOR_SUPERVISOR, 'service')
  assert.equal(bridge!.env?.[CODING_SESSIONS_CONFIG_DIGEST_ENV], digest)
  assert.deepEqual(other, otherSpec)
  assert.deepEqual(withDaemonSupervisor([bridgeSpec()], {}), [bridgeSpec()])
})

test('a coding-sessions entry that is not the executor\'s own bridge gets no _meta', async () => {
  const imposter: ExecutorLocalMcpServer = { ...otherSpec, name: 'coding-sessions' }
  const mcpSessions = createExecutorMcpSessionManager([imposter], { maxResultBytes: 65_536 }, { log: () => undefined })
  const codingBridge = createCodingSessionsDaemon({
    executorId, commandRules, facts, servers: [imposter], sessions: mcpSessions,
  })
  assert.equal(codingBridge.callMeta('coding-sessions', { commandId: 'c', owner: { agentId, actorUserId } }), undefined)
  await mcpSessions.stopAll()
})

type Call = { server: string; tool: string; args?: Record<string, unknown>; meta?: Record<string, unknown> }

const recording = (answer: (call: Call) => Record<string, unknown> = () => ({ closing: 1 })) => {
  const calls: Call[] = []
  let succeed = true
  const sessions: ExecutorMcpSessionManager = {
    callTool: async (server, tool, args, meta) => {
      const call: Call = { server, tool, ...(args ? { args } : {}), ...(meta ? { meta } : {}) }
      calls.push(call)
      if (!succeed) return { code: 'EXECUTOR_MCP_UNAVAILABLE', success: false }
      return { content: [{ type: 'text', text: JSON.stringify(answer(call)) }], success: true }
    },
    listTools: async () => ({}),
    probe: async () => ({ available: true, catalogDigest: digest, toolCount: 7 }),
    stopAll: async () => undefined,
  }
  return { calls, sessions, fail: () => { succeed = false }, recover: () => { succeed = true } }
}

test('teardown closes everything once, then only when an owner was dispatched since', async () => {
  const { calls, sessions, fail, recover } = recording()
  const daemon = createCodingSessionsDaemon({
    executorId, commandRules, facts, servers: [bridgeSpec()], sessions, log: () => undefined,
  })
  await daemon.closeAll('heartbeat_failed')
  assert.equal(calls.length, 1, 'sessions from an earlier daemon life may exist')
  assert.deepEqual(calls[0]!.args, { reason: 'heartbeat_failed' })
  assert.equal(calls[0]!.meta?.['nessie/daemon-control'], true)
  assert.match(String(calls[0]!.meta?.['nessie/command']), /^daemon-[0-9a-f-]{36}$/u)
  await daemon.closeAll('heartbeat_failed')
  assert.equal(calls.length, 1, 'nothing was dispatched since, so no bridge is started to close nothing')
  daemon.callMeta('coding-sessions', { commandId: 'x', owner: { agentId, actorUserId } })
  fail()
  await daemon.closeAll('command_poll_failed')
  assert.equal(calls.length, 2)
  recover()
  await daemon.closeAll('command_poll_failed')
  assert.equal(calls.length, 3, 'a close the bridge did not complete is tried again')
  await daemon.closeAll('command_poll_failed')
  assert.equal(calls.length, 3)
})

test('the heartbeat\'s codingSessionClose closes those owners\' sessions, and nothing when malformed', async () => {
  const { calls, sessions } = recording()
  const daemon = createCodingSessionsDaemon({
    executorId, pairingSource: () => pairingSource, commandRules, facts, servers: [bridgeSpec()], sessions,
  })
  const ownerKey = codingSessionOwnerKey(executorId, { agentId, actorUserId })
  const sessionId = '00000000-0000-4000-8000-000000000806'
  await daemon.close([{ ownerKey, reason: 'lease_ended' }, { ownerKey, sessionId, reason: 'closed_by_person' }])
  assert.deepEqual(calls.map((call) => [call.tool, call.args, call.meta?.['nessie/daemon-control']]), [
    ['session_close_all', { ownerKey, reason: 'lease_ended' }, true],
    ['session_close_all', { ownerKey, reason: 'closed_by_person', sessionId }, true],
  ])
  await daemon.close([{ ownerKey: 'owner-a', reason: 'lease_ended' }])
  await daemon.close('close everything')
  await daemon.close(undefined)
  assert.equal(calls.length, 2)
  const without = recording()
  await createCodingSessionsDaemon({
    executorId, commandRules, facts: undefined, servers: [], sessions: without.sessions,
  })
    .close([{ ownerKey, reason: 'lease_ended' }])
  assert.equal(without.calls.length, 0, 'an executor that offers no bridge has nothing to close')
})

test('heartbeatExecutor hands back the response\'s close instructions', async () => {
  const original = executorApi.heartbeat
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  const instruction = [{ ownerKey: `sha256:${'d'.repeat(64)}`, reason: 'executor_paused' }]
  executorApi.heartbeat = async () => ({ connectionEpoch: '4', status: 'online', codingSessionClose: instruction,
    existingSessionsAllowed: true })
  try {
    const state = { ...stateWith([bridgeSpec()]), connectionEpoch: '4', machinePrivateKey: key }
    const access: boolean[] = []
    assert.deepEqual(await heartbeatExecutor(state, undefined, (allowed) => { access.push(allowed) }), instruction)
    assert.deepEqual(access, [true])
    executorApi.heartbeat = async () => ({ connectionEpoch: '4', status: 'online' })
    assert.equal(await heartbeatExecutor(state, undefined, (allowed) => { access.push(allowed) }), undefined)
    assert.deepEqual(access, [true, false], 'an older or shared-scope heartbeat cannot enable native inventory')
  } finally {
    executorApi.heartbeat = original
  }
})

test('shutdown closes sessions only when the reviewed configuration opts in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-coding-shutdown-'))
  try {
    const configPath = join(dir, 'coding-sessions.json')
    const write = async (closeOnDaemonShutdown: boolean) => {
      const file = { codingSessions: {
        roots: [{ name: 'nessie', path: dir }], agents: { claude: { command: ['claude'] } }, closeOnDaemonShutdown,
      } }
      await writeFile(configPath, JSON.stringify(file))
      return codingSessionsConfigDigest(normalizeCodingSessionsConfig(file))
    }
    const shutdownCalls = async (reviewed: string) => {
      const { calls, sessions } = recording()
      const spec = { ...bridgeSpec(configPath), env: { [CODING_SESSIONS_CONFIG_DIGEST_ENV]: reviewed } }
      await createCodingSessionsDaemon({
        executorId, commandRules, facts: { ...facts, configDigest: reviewed }, servers: [spec], sessions,
      }).shutdown()
      return calls.map((call) => call.args)
    }
    assert.deepEqual(await shutdownCalls(await write(false)), [], 'sessions outlive a daemon restart by default')
    assert.deepEqual(await shutdownCalls(await write(true)), [{ reason: 'daemon_shutdown' }])
    // Edited since its review to opt out: that cannot be trusted, so it reads as opted in.
    await write(false)
    assert.deepEqual(await shutdownCalls(`sha256:${'e'.repeat(64)}`), [{ reason: 'daemon_shutdown' }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the local-MCP report lists the bridge\'s open sessions, and drops anything that is not a summary', async () => {
  const ownerKey = codingSessionOwnerKey(executorId, { agentId, actorUserId })
  const good = {
    sessionId: '00000000-0000-4000-8000-000000000807', ownerKey, title: 'Fix the flaky test', status: 'working',
    agent: 'claude', root: 'nessie', updatedAt: '2026-09-23T10:00:00.000Z',
  }
  // What a session has cost travels to the server unchanged, and a figure the schema refuses drops the entry.
  const costed = { ...good, sessionId: '00000000-0000-4000-8000-000000000808', turn: 3, totalCostUsd: 0.37 }
  const { calls, sessions } = recording(() => ({ sessions: [
    good, costed, { ...good, transcript: 'I edited…' }, { ...good, ownerKey: 'owner-a' },
    { ...costed, totalCostUsd: -1 },
  ] }))
  const daemon = createCodingSessionsDaemon({
    executorId, commandRules, facts, servers: [bridgeSpec(), otherSpec], sessions,
  })
  const reporter = createLocalMcpReporter([bridgeSpec(), otherSpec], sessions, { codingSessions: daemon.report })
  try {
    const report = await reporter.refresh()
    assert.deepEqual(report.find((status) => status.server === 'coding-sessions')?.codingSessions, [good, costed])
    assert.equal(report.find((status) => status.server === 'kelpie')?.codingSessions, undefined)
    assert.deepEqual(calls.map((call) => [call.tool, call.meta?.['nessie/daemon-control']]), [['session_list_all', true]])
  } finally {
    reporter.stop()
  }
})

test('a failed poll or heartbeat closes no coding session unless the failure is definitive or lasts', async () => {
  const { calls, sessions } = recording()
  let clock = 1_000_000
  const daemon = createCodingSessionsDaemon({
    executorId, commandRules, facts, servers: [bridgeSpec()], sessions, log: () => undefined, now: () => clock,
  })
  const blip = new ExecutorApiError('Executor API request timed out.', { code: 'EXECUTOR_API_TIMEOUT' })
  await daemon.connectionFailed('heartbeat_failed', blip)
  await daemon.connectionFailed('command_poll_failed', new Error('fetch failed'))
  await daemon.connectionFailed('heartbeat_failed', new ExecutorApiError('fenced', { code: 'EXECUTOR_CONNECTION_FENCED' }))
  clock += DISCONNECT_CLOSE_MS - 1
  await daemon.connectionFailed('heartbeat_failed', blip)
  assert.equal(calls.length, 0, 'a blip, an API deploy or a reclaim ends no 45-minute turn')
  daemon.connectionHealthy()
  clock += DISCONNECT_CLOSE_MS
  await daemon.connectionFailed('heartbeat_failed', blip)
  assert.equal(calls.length, 0, 'a heartbeat that got through starts the count again')
  clock += DISCONNECT_CLOSE_MS
  await daemon.connectionFailed('heartbeat_failed', blip)
  assert.deepEqual(calls.map((call) => call.args), [{ reason: 'connection_lost' }])

  const revoked = recording()
  const unknown = new ExecutorApiError('Executor is unavailable.', { code: 'EXECUTOR_NOT_FOUND', status: 404 })
  await createCodingSessionsDaemon({
    executorId, commandRules, facts, servers: [bridgeSpec()], sessions: revoked.sessions, log: () => undefined,
  }).connectionFailed('heartbeat_failed', unknown)
  assert.deepEqual(revoked.calls.map((call) => call.args), [{ reason: 'heartbeat_failed' }], 'a revoked executor closes at once')
})

test('a close the bridge could not carry out is tried again while the heartbeat still lists it', async () => {
  const { calls, sessions, fail, recover } = recording()
  const daemon = createCodingSessionsDaemon({
    executorId, commandRules, facts, servers: [bridgeSpec()], sessions, log: () => undefined,
  })
  const ownerKey = codingSessionOwnerKey(executorId, { agentId, actorUserId })
  const other = codingSessionOwnerKey(executorId, { agentId, actorUserId: runId })
  const listed = [{ ownerKey, reason: 'lease_ended' }]
  fail()
  await daemon.close(listed)
  await daemon.close(listed)
  assert.equal(calls.length, 2, 'a bridge still failing is asked again on each heartbeat that lists it')
  // A list this daemon cannot read changes nothing: the failed close is still owed.
  await daemon.close('close everything')
  assert.equal(calls.length, 3)
  recover()
  // The next heartbeat lists another owner beside it, the API having more to say.
  await daemon.close([...listed, { ownerKey: other, reason: 'access_revoked' }])
  assert.deepEqual(calls.slice(3).map((call) => call.args), [
    { ownerKey, reason: 'lease_ended' }, { ownerKey: other, reason: 'access_revoked' },
  ])
  await daemon.close(undefined)
  assert.equal(calls.length, 5, 'once it landed it is not sent again')
})

test('a close the heartbeat no longer lists is dropped, not retried into the owner’s new session', async () => {
  const { calls, sessions, fail, recover } = recording()
  const daemon = createCodingSessionsDaemon({
    executorId, commandRules, facts, servers: [bridgeSpec()], sessions, log: () => undefined,
  })
  const ownerKey = codingSessionOwnerKey(executorId, { agentId, actorUserId })
  fail()
  await daemon.close([{ ownerKey, reason: 'lease_ended' }])
  assert.equal(calls.length, 1)
  // The owner launched again: the API withdrew the request, and says nothing more.
  recover()
  await daemon.close(undefined)
  assert.equal(calls.length, 1, 'a withdrawn close would end the session the relaunch starts')
})

test('hosts may ask the owner only while the reviewed facts say so and this connection\'s Nessie reads requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-owner-lease-'))
  try {
    const configPath = join(dir, 'coding-sessions.json')
    const stateDir = join(dir, 'coding-sessions')
    await mkdir(stateDir)
    let reads = true
    type Daemon = ReturnType<typeof createCodingSessionsDaemon>
    const lease = async (ownerAnswers: boolean, act: (daemon: Daemon) => void) => {
      const daemon = createCodingSessionsDaemon({
        executorId, commandRules, servers: [bridgeSpec(configPath)], sessions: recording().sessions,
        log: () => undefined,
        facts: ownerAnswers ? { ...facts, ownerAnswers: true } : facts, serverReadsRequests: () => reads,
      })
      act(daemon)
      await new Promise((settle) => { setTimeout(settle, 100) })
      return ownerRequestsLeaseIsLive(stateDir)
    }
    assert.equal(await lease(false, (daemon) => daemon.connectionHealthy()), false,
      'facts reviewed before owners could answer keep prompts turned down')
    assert.equal(await lease(true, (daemon) => daemon.connectionHealthy()), true)
    reads = false
    assert.equal(await lease(true, (daemon) => daemon.connectionHealthy()), false, 'an older Nessie, as far as anyone knows')
    reads = true
    assert.equal(await lease(true, (daemon) => daemon.ownerRequestsChanged()), true, 'a ready tells the hosts at once')
    assert.equal(await lease(true, (daemon) => {
      daemon.connectionHealthy()
      void daemon.connectionFailed('heartbeat_failed', new Error('offline'))
    }), false, 'a failed heartbeat ends it: the reconnect may meet a different Nessie')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
