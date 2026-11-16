import assert from 'node:assert/strict'
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { request } from 'node:http'
import test from 'node:test'

import { canonicalExecutorJson, canonicalExecutorPayload, executorCodingSessionResultScope,
  type ExecutorCodingSessionAuthority, type ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import { signExecutorDaemonPayload } from '../src/daemon-signature.js'
import { executorDebugChild, executorDebugMode } from '../src/debug-mode.js'
import { enqueue, handleDaemon, productionAnswer, type DaemonContext } from '../src/debug-nessie/daemon.js'
import { claim, handlePairing, referenceFor } from '../src/debug-nessie/pairing.js'
import { startDebugNessie } from '../src/debug-nessie/server.js'
import { signedDescriptorForState } from '../src/pair.js'
import { createSessionAuthorityClient } from '../src/session-authority-client.js'
import type { ExecutorLocalState } from '../src/state-store.js'

/** One machine key, signing as the real computer does. */
const machine = (name = 'Test computer') => {
  const keys = generateKeyPairSync('ed25519')
  const machinePrivateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  const machinePublicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const state: ExecutorLocalState = { apiBaseUrl: 'http://127.0.0.1:5454', executorId: randomUUID(),
    machinePrivateKey, machinePublicKey, connectionEpoch: '0',
    descriptor: { limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['sandbox.stop'], profiles: ['workspace_sandbox'], revision: 1 },
    workspaceFolders: [] }
  const pairing = (action: string, payload: Record<string, unknown>): string => sign(null,
    Buffer.from(canonicalExecutorPayload(`nessie.executor.pairing.${action}.v1`, payload)),
    createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.from(machinePrivateKey, 'base64url') }),
  ).toString('base64url')
  return { name, state, machinePublicKey, machinePrivateKey, pairing }
}

const context = (): DaemonContext => ({
  state: { pairings: [], computers: [] }, queue: [], challenges: new Map(), authorities: new Map(),
  authorityChecks: new Map(), log: () => undefined,
  options: { sessions: 'bound', concurrentPoll: false, latencyMs: 0, clockSkewMs: 0 },
})

const organization = referenceFor('organization', 'Acme')
const team = referenceFor('team', 'Platform')

/** Starts a pairing and has a person claim its code, as the Add a computer dialog would. */
const pair = (c: DaemonContext, m: ReturnType<typeof machine>) => {
  const payload = { requestId: randomUUID(), timestamp: new Date().toISOString(), machineName: m.name,
    machinePublicKey: m.machinePublicKey, descriptor: signedDescriptorForState(m.state) }
  const started = handlePairing(c.state, 'start', { ...payload, signature: m.pairing('start', payload) })
  assert.equal(started.status, 200, JSON.stringify(started.error))
  const { code, pairingId } = started.data as { code: string; pairingId: string }
  assert.match(code, /^[0-9]{8}$/u)
  const poll = () => {
    const body = { pairingId, timestamp: new Date().toISOString() }
    return handlePairing(c.state, 'poll', { ...body, signature: m.pairing('poll', body) }).data as {
      status: string; claim?: { executorId: string; claimDigest: string }; reusedConnection?: { executorId: string } }
  }
  assert.equal(poll().status, 'waiting')
  const { computer } = claim(c.state, code, organization, team)
  const confirmed = poll()
  assert.equal(confirmed.status, 'confirmed')
  assert.equal(confirmed.claim?.executorId, computer.id)
  return { pairingId, computer, claimDigest: confirmed.claim!.claimDigest, poll }
}

const connection = (c: DaemonContext, m: ReturnType<typeof machine>, executorId: string, action = 'connection') => {
  const body = { executorId, timestamp: new Date().toISOString() }
  return handlePairing(c.state, action, { ...body, signature: m.pairing(action, body) })
}

test('a computer pairs, and adding its team again returns to the connection it has', () => {
  const c = context()
  const first = machine()
  const kept = pair(c, first)
  // The daemon was heard from, so this connection is a row a person would see.
  kept.computer.lastSeenAt = new Date().toISOString()

  const second = machine()
  const again = pair(c, second)
  const reuse = { pairingId: again.pairingId, timestamp: new Date().toISOString(), executorId: again.computer.id,
    claimDigest: again.claimDigest, retainedExecutorId: kept.computer.id }
  const unsigned = handlePairing(c.state, 'reuse', { ...reuse, signature: second.pairing('reuse', reuse),
    retainedSignature: second.pairing('reuse', reuse) })
  assert.equal(unsigned.error?.code, 'ENROLLMENT_PROOF_INVALID', 'both machine keys prove the reuse')
  const reused = handlePairing(c.state, 'reuse', { ...reuse, signature: second.pairing('reuse', reuse),
    retainedSignature: first.pairing('reuse', reuse) })
  assert.equal((reused.data as { status: string }).status, 'reused')
  assert.equal(again.poll().reusedConnection?.executorId, kept.computer.id)
  assert.deepEqual(c.state.computers.map(computer => computer.id), [kept.computer.id],
    'a connection no daemon was ever heard from leaves no row')
  assert.equal(connection(c, first, kept.computer.id).status, 200)

  assert.deepEqual(connection(c, first, kept.computer.id, 'sign-off').data, { signedOff: true })
  assert.equal(connection(c, first, kept.computer.id).status, 410, 'only its own key learns it is inactive')
})

test('a cancelled attempt cannot be reopened by its own late start', () => {
  const c = context()
  const m = machine()
  const requestId = randomUUID()
  const cancel = { pairingId: requestId, timestamp: new Date().toISOString(), machinePublicKey: m.machinePublicKey }
  assert.equal(handlePairing(c.state, 'cancel', { ...cancel, signature: m.pairing('cancel', cancel) }).status, 200)
  const start = { requestId, timestamp: new Date().toISOString(), machineName: m.name,
    machinePublicKey: m.machinePublicKey, descriptor: signedDescriptorForState(m.state) }
  assert.equal(handlePairing(c.state, 'start', { ...start, signature: m.pairing('start', start) }).error?.code,
    'ENROLLMENT_USED')
  assert.throws(() => claim(c.state, '00000000', organization, team), /did not work/u)
})

test('a connected computer takes a session command, and the route\'s answer passes the computer\'s own check', async () => {
  const c = context()
  const m = machine()
  const { computer } = pair(c, m)
  const challenge = (handleDaemon(c, 'challenge', { executorId: computer.id }).data as { challenge: string }).challenge
  const claimed = handleDaemon(c, 'claim', { executorId: computer.id, challenge,
    signature: signExecutorDaemonPayload(m.machinePrivateKey, 'claim', { challenge, executorId: computer.id }) })
  const online = claimed.data as { connectionEpoch: string; sessionPairingSource: { kind: string } }
  assert.equal(online.sessionPairingSource.kind, 'bound')
  assert.equal(handleDaemon(c, 'heartbeat', { executorId: computer.id, connectionEpoch: '0' }).error?.code,
    'EXECUTOR_CONNECTION_FENCED', 'an earlier connection is fenced')

  const queued = enqueue(c, computer, 'mcp.call',
    { server: 'coding-sessions', tool: 'session_list', arguments: {} })
  const polled = handleDaemon(c, 'commands/poll', { executorId: computer.id, connectionEpoch: online.connectionEpoch })
  const envelope = (polled.data as { command: ExecutorCommandEnvelope }).command
  assert.equal(envelope.commandId, queued.commandId)
  const { codingSessionAuthority: authority } = envelope.payload as {
    codingSessionAuthority: ExecutorCodingSessionAuthority }
  assert.equal(authority.operation, 'session_list')

  // The computer's real client reads the stand-in's answer, with the server's clock 300 ms ahead of its own.
  const state: ExecutorLocalState = { ...m.state, executorId: computer.id, connectionEpoch: online.connectionEpoch,
    sessionPairingSource: online.sessionPairingSource as ExecutorLocalState['sessionPairingSource'] }
  const check = createSessionAuthorityClient(() => state, { checkSessionAuthority: (_origin, input) => {
    const reply = handleDaemon(c, 'session-authority', input as Record<string, unknown>, Date.now() + 300)
    return reply.error ? Promise.reject(new Error(reply.error.code)) : Promise.resolve(reply.data as never)
  } })
  const checked = await check(authority, 'execute')
  assert.ok(Date.parse(checked.permit.expiresAt) - Date.now() <= 5_000)
  assert.ok(Date.parse(checked.carrier.expiresAt) - Date.now() > 20_000)
  assert.equal(c.authorityChecks.get(queued.commandId), 1)

  const receipt = (stateName: string, result?: Record<string, unknown>) => handleDaemon(c, 'commands/receipt', {
    executorId: computer.id, connectionEpoch: online.connectionEpoch,
    receipt: { commandId: queued.commandId, state: stateName }, ...(result ? { result } : {}) })
  receipt('accepted')
  const answer = { success: true, content: [{ type: 'text', text: JSON.stringify({ sessions: [],
    resultScope: executorCodingSessionResultScope(authority) }) }] }
  receipt('result_acknowledged', answer)
  assert.deepEqual(await queued.result, answer)
  assert.deepEqual(queued.states, ['accepted', 'result_acknowledged'])
  assert.equal(productionAnswer(c, computer, queued.commandId, answer), 'delivered to the agent')
  assert.match(productionAnswer(c, computer, queued.commandId, { success: false, code: 'EXECUTOR_COMMAND_DENIED' }),
    /^EXECUTOR_CODING_SESSION_RESULT_WITHHELD/u, 'an answer without the command\'s scope is withheld in production')
  assert.equal(productionAnswer(c, computer, queued.commandId, { ...answer, success: false }),
    'EXECUTOR_CODING_SESSION_CALL_REFUSED')
  assert.equal(canonicalExecutorJson(executorCodingSessionResultScope(checked.carrier)),
    canonicalExecutorJson(executorCodingSessionResultScope(authority)), 'the route never changes the selection')
})

const ask = (port: number, path: string, body?: Record<string, unknown>) => new Promise<{
  status: number; body: { data?: Record<string, unknown>; error?: { code: string } } }>((resolve, reject) => {
  const sent = request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' } }, response => {
    const chunks: Buffer[] = []
    response.on('data', (chunk: Buffer) => chunks.push(chunk))
    response.on('end', () => resolve({ status: response.statusCode ?? 0,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as never }))
  })
  sent.on('error', reject)
  sent.end(body ? JSON.stringify(body) : undefined)
})

test('the control plane listens on loopback, takes its options and names a route it does not serve', async t => {
  const lines: string[] = []
  const nessie = await startDebugNessie({ port: 0, log: line => lines.push(line) })
  t.after(() => nessie.close())
  assert.match(nessie.url, /^http:\/\/127\.0\.0\.1:\d+$/u)
  const options = await ask(nessie.port, '/debug/options', { latencyMs: 5, clockSkewMs: -40 })
  assert.deepEqual(options.body.data, { sessions: 'bound', concurrentPoll: false, latencyMs: 5, clockSkewMs: -40 })
  assert.deepEqual((await ask(nessie.port, '/debug/state')).body.data?.computers, [])
  assert.equal((await ask(nessie.port, '/api/something-new', {})).status, 404)
  assert.ok(lines.some(line => line.includes('not served: POST /api/something-new')))
  assert.equal((await ask(nessie.port, '/debug/command', { computer: '', operationKey: 'file.list' })).body.error?.code,
    'DEBUG_REQUEST_FAILED', 'a command needs a connected computer')
})

test('debug mode needs the loopback-only variable too, so a released app is never in it', () => {
  assert.equal(executorDebugMode({ NESSIE_COMPUTER_DEBUG: '1' }), false)
  assert.equal(executorDebugMode({ NESSIE_COMPUTER_DEBUG: '1', NESSIE_EXECUTOR_ALLOW_LOCAL_API: '1' }), true)
  assert.equal(executorDebugMode({ NESSIE_EXECUTOR_ALLOW_LOCAL_API: '1' }), false)
  assert.equal(executorDebugChild({ NESSIE_COMPUTER_DEBUG: '1' }), true)
  assert.equal(executorDebugChild({}), false)
})
