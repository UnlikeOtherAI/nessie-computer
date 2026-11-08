import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import { decodeExecutorT3Request } from '@nessie/executor-protocol/t3-session'
import { makeSessionInspectionLeases } from '../../dist/t3-session/runtime/inspection-leases.js'

const fixture = async () => {
  const root = await Effect.runPromise(Scope.make())
  const started = Promise.withResolvers()
  let calls = 0, finalized = false
  // A nonterminating refusal trap: this fixture issues no graph or native proof.
  const owner = { inspect: () => Effect.gen(function* () {
    calls++
    yield* Effect.addFinalizer(() => Effect.sync(() => { finalized = true }))
    started.resolve()
    return yield* Effect.never
  }) }
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
    relayHmac, retentionExpiresAt: now + 30_000 }
  return { root, leases, request, delivery, started: started.promise,
    calls: () => calls, finalized: () => finalized, id: inspection.inspectionId }
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
      { ...f.delivery, retentionExpiresAt: f.delivery.retentionExpiresAt + 1 }, caller.signal),
    /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
    assert.equal(f.calls(), 1)
    await f.leases.release(f.id)
    await stopped
  } finally { await Effect.runPromise(Scope.close(f.root, Exit.void)) }
})
