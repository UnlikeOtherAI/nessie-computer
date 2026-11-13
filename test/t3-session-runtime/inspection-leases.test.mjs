import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import { decodeExecutorT3Request } from '@nessie/executor-protocol/t3-session'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { makeSessionInspectionLeases } from '../../dist/t3-session/runtime/inspection-leases.js'

const fixture = async (completed = false, failCleanup = false) => {
  const root = await Effect.runPromise(Scope.make())
  const started = Promise.withResolvers()
  let calls = 0, checks = 0, finalized = false
  // Only the lease lifecycle is exercised by this synthetic owner. Its receipt
  // cannot pass real native verification and never authorizes an operation.
  const receipt = { domain: 'nessie.t3.execution.graph.v1', keyId: 'b'.repeat(64),
    payload: '{}', signature: 'not-native-proof' }
  const owner = { recheck: Effect.sync(() => { checks++ }), inspect: () => Effect.gen(function* () {
    calls++
    yield* Effect.addFinalizer(() => Effect.sync(() => { finalized = true }))
    started.resolve()
    return completed ? { receipt } : yield* Effect.never
  }).pipe(Effect.onInterrupt(() => failCleanup
    ? Effect.die(new Error('synthetic inspection cleanup failure')) : Effect.void)) }
  const leases = await Effect.runPromise(makeSessionInspectionLeases(owner).pipe(
    Effect.provideService(Scope.Scope, root)))
  const request = decodeExecutorT3Request({ transportVersion: 1, protocolVersion: 2,
    sourceRevision: '25bf84ab07f53f141c20239c63e383823a9d5ea0',
    executorId: '11111111-1111-4111-8111-111111111111', environmentId: 'original',
    connectionEpoch: '1', runtimeGeneration: 'writer', correlationId: 'correlation', relayOrdinal: 0,
    kind: 'request', method: 'orchestration.launchThread', commandId: 'command',
    input: { commandId: 'command', projectId: 'project', title: 'Inspection',
      modelSelection: { instanceId: 'codex', model: 'model' }, runtimeMode: 'full-access',
      interactionMode: 'default', workspaceStrategy: { type: 'root' } } })
  const sha = 'sha256:' + 'a'.repeat(64)
  const relayHmac = 'hmac-sha256:' + 'b'.repeat(64)
  const now = Date.now()
  const inspection = { version: 1, inspectionId: 'a'.repeat(64), issuerKeyId: 'b'.repeat(64), nonce: 'c'.repeat(64),
    executorId: request.executorId, environmentId: request.environmentId, connectionEpoch: request.connectionEpoch,
    runtimeGeneration: request.runtimeGeneration, correlationId: request.correlationId, commandId: 'command',
    requestSha256: sha, relayHmac, actorReference: sha, initiationReference: sha,
    sourceRootKey: 'root', sourceGeneration: 'capture', sourceRevision: request.sourceRevision,
    targets: [], issuedAtMs: now, expiresAtMs: now + 5000 }
  const delivery = { inspection: { payload: JSON.stringify(inspection), keyId: 'b'.repeat(64), signature: 'synthetic' },
    relayHmac, retentionExpiresAt: new Date(now + 30_000).toISOString() }
  return { root, leases, request, delivery, started: started.promise,
    calls: () => calls, checks: () => checks, finalized: () => finalized, id: inspection.inspectionId,
    accepted: { inspectionId: inspection.inspectionId, graphId: 'd'.repeat(64),
      expiresAt: new Date(now + 20_000).toISOString(),
      receiptDigest: 'sha256:' + createHash('sha256').update(canonicalExecutorJson(receipt)).digest('hex'),
      executorId: inspection.executorId, environmentId: inspection.environmentId,
      connectionEpoch: inspection.connectionEpoch, runtimeGeneration: inspection.runtimeGeneration,
      sourceRevision: inspection.sourceRevision, physicalRootKey: inspection.sourceRootKey,
      captureGeneration: inspection.sourceGeneration, correlationId: inspection.correlationId,
      commandId: inspection.commandId, requestSha256: inspection.requestSha256, relayHmac } }
}

test('owner closure interrupts and joins a pending inspection before scope resources release', async () => {
  const f = await fixture()
  const caller = new AbortController()
  const stopped = assert.rejects(f.leases.prepare(f.request, f.delivery, caller.signal))
  await f.started
  await Effect.runPromise(Scope.close(f.root, Exit.void))
  await stopped
  assert.equal(f.finalized(), true)
  await assert.rejects(f.leases.prepare(f.request, f.delivery, caller.signal), /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
  assert.equal(f.calls(), 1)
})

test('explicit release joins cancellation and refuses replay of the same still-signable challenge', async () => {
  const f = await fixture()
  const caller = new AbortController()
  try {
    const stopped = assert.rejects(f.leases.prepare(f.request, f.delivery, caller.signal))
    await f.started
    await f.leases.release(f.id)
    await stopped
    assert.equal(f.finalized(), true)
    await assert.rejects(f.leases.prepare(f.request, f.delivery, caller.signal), /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
    assert.equal(f.calls(), 1)
  } finally { await Effect.runPromise(Scope.close(f.root, Exit.void)) }
})

test('a failed interruption cleanup remains failed through release and owner closure', async () => {
  const f = await fixture(false, true)
  const caller = new AbortController()
  const stopped = assert.rejects(f.leases.prepare(f.request, f.delivery, caller.signal))
  await f.started
  await assert.rejects(f.leases.release(f.id), /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
  await stopped
  assert.equal(f.finalized(), true)
  await assert.rejects(f.leases.release(f.id), /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
  await assert.rejects(Effect.runPromise(Scope.close(f.root, Exit.void)), /T3_INSPECTION_RELEASE_FAILED/u)
})

test('resource deadline cancels without pipe cancellation; signing expiry alone does not retire the owner', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const f = await fixture()
  const caller = new AbortController()
  try {
    const stopped = assert.rejects(f.leases.prepare(f.request, f.delivery, caller.signal))
    await f.started
    t.mock.timers.tick(5001)
    assert.equal(f.finalized(), false)
    assert.equal(caller.signal.aborted, false)
    t.mock.timers.tick(25_000)
    await stopped
    await f.leases.release(f.id)
    assert.equal(f.finalized(), true)
    assert.equal(caller.signal.aborted, false)
  } finally { await Effect.runPromise(Scope.close(f.root, Exit.void)) }
})

test('a retry cannot extend the original resource deadline', async () => {
  const f = await fixture()
  const caller = new AbortController()
  try {
    const stopped = assert.rejects(f.leases.prepare(f.request, f.delivery, caller.signal))
    await f.started
    await assert.rejects(f.leases.prepare(f.request,
      { ...f.delivery, retentionExpiresAt: new Date(Date.parse(f.delivery.retentionExpiresAt) + 1).toISOString() },
      caller.signal),
    /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
    assert.equal(f.calls(), 1)
    await f.leases.release(f.id)
    await stopped
  } finally { await Effect.runPromise(Scope.close(f.root, Exit.void)) }
})

test('ACK retains the same selection and only shortens its resource deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const f = await fixture(true)
  const caller = new AbortController()
  try {
    await f.leases.prepare(f.request, f.delivery, caller.signal)
    t.mock.timers.tick(5001)
    assert.equal(f.finalized(), false)
    await f.leases.accept(f.request, f.accepted, caller.signal)
    await f.leases.accept(f.request, f.accepted, caller.signal)
    assert.equal(f.checks(), 1)
    assert.equal(f.calls(), 1)
    assert.equal(f.finalized(), false)
    await assert.rejects(f.leases.accept(f.request,
      { ...f.accepted, expiresAt: f.delivery.retentionExpiresAt }, caller.signal),
    /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
    t.mock.timers.tick(15_000)
    await f.leases.release(f.id)
    assert.equal(f.finalized(), true)
    assert.equal(caller.signal.aborted, false)
  } finally { await Effect.runPromise(Scope.close(f.root, Exit.void)) }
})

test('ACK requires exact original request, receipt, source and caller lifetime', async () => {
  const f = await fixture(true)
  const caller = new AbortController()
  try {
    await f.leases.prepare(f.request, f.delivery, caller.signal)
    const substitutions = { receiptDigest: 'sha256:' + 'e'.repeat(64),
      executorId: '22222222-2222-4222-8222-222222222222',
      environmentId: 'other', connectionEpoch: '2', runtimeGeneration: 'other', physicalRootKey: 'other',
      captureGeneration: 'other', correlationId: 'other', commandId: 'other', requestSha256: 'sha256:' + 'e'.repeat(64),
      relayHmac: 'hmac-sha256:' + 'e'.repeat(64),
      expiresAt: new Date(Date.parse(f.delivery.retentionExpiresAt) + 1).toISOString() }
    for (const [field, value] of Object.entries(substitutions)) {
      await assert.rejects(f.leases.accept(f.request, { ...f.accepted, [field]: value }, caller.signal))
    }
    await assert.rejects(f.leases.accept({ ...f.request, input: { ...f.request.input, title: 'changed' } },
      f.accepted, caller.signal))
    await assert.rejects(f.leases.accept(f.request, f.accepted, new AbortController().signal))
    assert.equal(f.checks(), 0)
    await f.leases.accept(f.request, f.accepted, caller.signal)
    assert.equal(f.checks(), 1)
  } finally { await Effect.runPromise(Scope.close(f.root, Exit.void)) }
})
