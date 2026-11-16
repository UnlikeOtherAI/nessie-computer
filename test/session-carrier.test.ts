import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { canonicalExecutorJson, type ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { executorApi } from '../src/api-client.js'
import { createSessionAuthorityClient } from '../src/session-authority-client.js'
import { saveExecutorState, type ExecutorLocalState } from '../src/state-store.js'
import { SessionEffectAuthority, requestEffectAuthority } from '../src/coding-session/session-effect-authority.js'
import { codingSessionPaths } from '../src/coding-session/session-files.js'
import { listRequests, writeRequest } from '../src/coding-session/session-requests.js'
import type { CodingSessionMeta } from '../src/coding-session/types.js'

const fixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-carrier-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const scope: ExecutorCodingSessionAuthority = { version: 1, executorId: randomUUID(),
    originalOwnerGeneration: randomUUID(), ownerKey: `sha256:${'a'.repeat(64)}`, commandId: randomUUID(),
    operation: 'session_start', purpose: 'control', issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5_000).toISOString(), connectionEpoch: '1', authorizationRevision: 1,
    filter: {}, admissions: [] }
  const keys = generateKeyPairSync('ed25519')
  const state: ExecutorLocalState = { apiBaseUrl: 'https://carrier.example', executorId: scope.executorId,
    machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    machinePublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), connectionEpoch: '1',
    sessionPairingSource: { kind: 'bound', executorId: scope.executorId,
      originalOwnerGeneration: scope.originalOwnerGeneration, machinePublicKeyDigest: 'b'.repeat(64),
      acceptedPairing: { kind: 'code', id: randomUUID() } },
    descriptor: { limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['sandbox.stop'], profiles: ['workspace_sandbox'], revision: 1 },
    workspaceFolders: [{ name: 'work', path: root }] }
  const directory = join(root, 'connection')
  await saveExecutorState(directory, state)
  let calls = 0, revoked = false, ahead = 0, slowChecks = 0
  let change: Partial<ExecutorCodingSessionAuthority> = {}
  let carrier = scope
  t.mock.method(executorApi, 'checkSessionAuthority', async (_origin, request) => {
    calls++
    if (revoked) throw new Error('Original authority revoked')
    const { signature: _signature, ...payload } = request
    carrier = { ...scope, issuedAt: new Date(now + ahead).toISOString(),
      expiresAt: new Date(now + ahead + 30_000).toISOString(), ...change }
    // This computer's own reads after the answer outlast the permit: the clock moves once the client has it.
    if (slowChecks > 0) { slowChecks -= 1; setImmediate(() => { now += 5_100 }) }
    return { commandId: scope.commandId, selectionDigest: request.selectionDigest, phase: request.phase,
      requestNonce: request.requestNonce,
      requestDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}`,
      purpose: scope.purpose, connectionEpoch: scope.connectionEpoch,
      authorizationRevision: scope.authorizationRevision,
      validUntil: new Date(now + ahead + 5_000).toISOString(),
      authority: carrier }
  })
  const sessionId = randomUUID()
  const paths = codingSessionPaths(join(directory, 'coding-sessions'), sessionId)
  await mkdir(paths.inbox, { recursive: true })
  const meta: CodingSessionMeta = { version: 1, sessionId, ownerKey: scope.ownerKey, agent: 'terminal',
    rootName: '', path: '.', title: 'Carrier fixture', createdAt: new Date(now).toISOString(),
    originalManagedStart: { executorId: scope.executorId, originalOwnerGeneration: scope.originalOwnerGeneration,
      startCommandId: scope.commandId } }
  return { directory, state, scope, paths, meta, carrier: () => carrier, calls: () => calls,
    advance: (ms: number) => { now += ms }, revoke: () => { revoked = true },
    serverAhead: (ms: number) => { ahead = ms },
    slowLocalChecks: (times: number) => { slowChecks = times },
    substitute: (patch: Partial<ExecutorCodingSessionAuthority>) => { change = patch } }
}

test('a delayed host consumes the unchanged route carrier, not its parent\'s expired effect permit', async t => {
  const f = await fixture(t)
  const parent = new SessionEffectAuthority(f.directory, f.scope)
  assert.throws(() => parent.queuedCarrier, 'no carrier exists before an owning-route exchange')
  await writeRequest(f.paths, { id: f.scope.commandId, kind: 'start', text: 'original prompt',
    at: f.meta.createdAt }, parent)
  const request = (await listRequests(f.paths))[0]!
  assert.deepEqual(request.sessionAuthority, f.carrier(), 'retain exactly the server-issued carrier')
  assert.equal(Date.parse(parent.scope.expiresAt) - Date.now(), 5_000)
  assert.equal(Date.parse(request.sessionAuthority!.expiresAt) - Date.now(), 30_000)
  const retainedPath = join(f.paths.dir, 'request-intents', `${f.scope.commandId}.json`)
  const originalBytes = await readFile(retainedPath)
  f.advance(6_000) // Installed failure: the host reached its inbox after the original five-second permit.
  assert.throws(() => parent.assertLive())
  assert.throws(() => parent.queuedCarrier, 'an expired permit hands nothing on until the route answers again')
  const before = f.calls()
  const host = requestEffectAuthority(f.directory, f.meta, request)!
  await host.consume()
  assert.equal(f.calls(), before + 1, 'the queued carrier itself grants no effect')
  assert.equal(Date.parse(host.scope.expiresAt) - Date.now(), 5_000)
  assert.deepEqual(await readFile(retainedPath), originalBytes, 'no queue lease rewriting')
  assert.equal(await writeRequest(f.paths, { ...request, text: 'replay' }, host).catch(() => false), false)
  assert.deepEqual(await readFile(retainedPath), originalBytes, 'a later permit cannot replace original intent')
})

test('a permit covers the effects inside it, and a slow answer costs a round trip, never the operation', async t => {
  const f = await fixture(t)
  const parent = new SessionEffectAuthority(f.directory, f.scope)
  await parent.consume()
  assert.equal(f.calls(), 1, 'the reference this began with grants no effect by itself')
  await parent.consume()
  f.advance(3_000)
  await parent.consume()
  assert.equal(f.calls(), 1, 'the route already answered for these seconds')
  f.advance(1_000)
  await parent.consume()
  assert.equal(f.calls(), 2, 'a permit about to run out is asked for again')
  assert.equal(Date.parse(parent.scope.expiresAt) - Date.now(), 5_000)
  // Installed failure: on a slow connection the next answer arrived after the previous permit had run out,
  // and every session start was refused. The route's own thirty-second reference asks instead.
  f.advance(6_000)
  assert.throws(() => parent.assertLive(), 'no permit outlives its five seconds')
  await parent.consume()
  assert.equal(f.calls(), 3)
  assert.equal(Date.parse(parent.scope.expiresAt) - Date.now(), 5_000, 'only the route issues the next permit')
  assert.equal(Date.parse(parent.queuedCarrier.expiresAt) - Date.now(), 30_000)
  const inherited = SessionEffectAuthority.fromReference(parent.reference)!
  await inherited.consume()
  assert.equal(f.calls(), 4, 'a reference handed to another process is never a permit there')
  f.revoke()
  await parent.consume()
  f.advance(4_000)
  await assert.rejects(parent.consume(), 'revoked authority stops at the next request')
  assert.equal(f.calls(), 5)
  f.advance(31_000)
  await assert.rejects(parent.consume())
  assert.equal(f.calls(), 5, 'an expired reference cannot ask the route to revive it')
})

test('a process handed a permit with the route\'s reference asks with the reference once the permit is gone', async t => {
  const f = await fixture(t)
  const daemon = new SessionEffectAuthority(f.directory, f.scope)
  await daemon.consume()
  // Installed failure: the daemon handed the session bridge its five-second permit alone, and on a slow
  // connection the bridge's own request outlived it, so every session call was refused.
  const bridge = new SessionEffectAuthority(f.directory, daemon.scope, f.carrier())
  const child = SessionEffectAuthority.fromReference(daemon.reference)!
  assert.throws(() => bridge.queuedCarrier, 'a handed reference is not this process\'s own exchange')
  f.advance(6_000)
  const before = f.calls()
  await bridge.consume()
  await child.consume()
  assert.equal(f.calls(), before + 2, 'each process obtains its own permit from the route')
  assert.equal(Date.parse(bridge.scope.expiresAt) - Date.now(), 5_000)
  const other = { ...f.carrier(), commandId: randomUUID() }
  assert.throws(() => new SessionEffectAuthority(f.directory, daemon.scope, other),
    'a reference for another operation is refused')
  const late = new SessionEffectAuthority(f.directory, daemon.scope, f.carrier())
  f.advance(31_000)
  await assert.rejects(late.consume())
  assert.equal(f.calls(), before + 2, 'an expired reference asks nothing')
})

test('a permit that ran out during this computer\'s own checks is asked for again, three times at most', async t => {
  const f = await fixture(t)
  const effect = new SessionEffectAuthority(f.directory, f.scope)
  await effect.consume()
  f.advance(4_000)
  // Installed failure: on a busy Windows computer the state checks after a slow answer outlasted the permit,
  // the terminal's input was refused and its session ended.
  f.slowLocalChecks(1)
  await effect.consume()
  assert.equal(f.calls(), 3, 'one answer wasted, one used')
  assert.equal(Date.parse(effect.scope.expiresAt) - Date.now(), 5_000)
  f.advance(4_000)
  f.slowLocalChecks(3)
  await assert.rejects(effect.consume(), 'a computer that never finishes in time is refused, not looped')
  assert.equal(f.calls(), 6)
})

test('a server clock a little ahead or behind still permits, and never for longer than five seconds', async t => {
  const f = await fixture(t)
  // Installed failure: the route stamps its deadline five seconds from its own clock, and a computer whose
  // clock ran a few milliseconds behind refused every answer as "more than five seconds".
  f.serverAhead(40)
  const slow = new SessionEffectAuthority(f.directory, f.scope)
  await slow.consume()
  assert.equal(Date.parse(slow.scope.expiresAt) - Date.now(), 5_000, 'cut at five seconds of this computer\'s time')
  f.serverAhead(-1_000)
  const fast = new SessionEffectAuthority(f.directory, f.scope)
  await fast.consume()
  assert.equal(Date.parse(fast.scope.expiresAt) - Date.now(), 4_000, 'a deadline already nearer is kept')
  f.serverAhead(2_500)
  await assert.rejects(new SessionEffectAuthority(f.directory, f.scope).consume(), 'a clock this wrong is refused')
})

test('expired carriers and revoked authority never reach a host effect', async t => {
  const f = await fixture(t)
  const parent = new SessionEffectAuthority(f.directory, f.scope)
  await writeRequest(f.paths, { id: f.scope.commandId, kind: 'start', at: f.meta.createdAt }, parent)
  const request = (await listRequests(f.paths))[0]!
  f.advance(6_000)
  f.revoke()
  await assert.rejects(requestEffectAuthority(f.directory, f.meta, request)!.consume())
  f.advance(25_000)
  const before = f.calls()
  await assert.rejects(requestEffectAuthority(f.directory, f.meta, request)!.consume())
  assert.equal(f.calls(), before, 'an expired carrier cannot ask the route to revive it')
})

test('the owning response cannot substitute any selected identity or operation', async t => {
  const f = await fixture(t)
  const check = createSessionAuthorityClient(() => f.state)
  for (const patch of [{ commandId: randomUUID() }, { originalOwnerGeneration: randomUUID() },
    { executorId: randomUUID() }, { ownerKey: `sha256:${'c'.repeat(64)}` }, { connectionEpoch: '2' },
    { authorizationRevision: 2 }, { operation: 'session_interrupt' as const }]) {
    f.substitute(patch)
    await assert.rejects(check(f.scope, 'execute'))
  }
})
