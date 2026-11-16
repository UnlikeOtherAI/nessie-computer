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
  let calls = 0, revoked = false
  let change: Partial<ExecutorCodingSessionAuthority> = {}
  let carrier = scope
  t.mock.method(executorApi, 'checkSessionAuthority', async (_origin, request) => {
    calls++
    if (revoked) throw new Error('Original authority revoked')
    const { signature: _signature, ...payload } = request
    carrier = { ...scope, issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30_000).toISOString(), ...change }
    return { commandId: scope.commandId, selectionDigest: request.selectionDigest, phase: request.phase,
      requestNonce: request.requestNonce,
      requestDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}`,
      purpose: scope.purpose, connectionEpoch: scope.connectionEpoch,
      authorizationRevision: scope.authorizationRevision, validUntil: new Date(now + 5_000).toISOString(),
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
  assert.throws(() => parent.queuedCarrier, 'an expired parent cannot issue another handoff')
  const before = f.calls()
  await assert.rejects(parent.consume())
  assert.equal(f.calls(), before, 'an expired permit cannot renew itself through its carrier')
  const host = requestEffectAuthority(f.directory, f.meta, request)!
  await host.consume()
  assert.equal(f.calls(), before + 1, 'the queued carrier itself grants no effect')
  assert.equal(Date.parse(host.scope.expiresAt) - Date.now(), 5_000)
  assert.deepEqual(await readFile(retainedPath), originalBytes, 'no queue lease rewriting')
  assert.equal(await writeRequest(f.paths, { ...request, text: 'replay' }, host).catch(() => false), false)
  assert.deepEqual(await readFile(retainedPath), originalBytes, 'a later permit cannot replace original intent')
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
