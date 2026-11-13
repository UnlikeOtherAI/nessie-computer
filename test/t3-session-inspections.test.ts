import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { decodeExecutorT3LaneOperation, encodeExecutorT3LaneOperation, T3_SOURCE_COMMIT, T3_EXECUTION_GRAPH_DOMAIN,
  type T3LaneInspection, type T3LaneInspectionAccepted, type T3InspectionRuntimeAnnouncement,
} from '@nessie/executor-protocol/t3-session'
import { createT3InspectionPump } from '../src/t3-session-inspections.js'

// Transport/lifecycle fixtures only. Synthetic envelopes never assert positive
// native proof, source authority, graph acceptance or effect permission.
const fixture = (now: number) => {
  const request = decodeExecutorT3LaneOperation({ transportVersion: 1, protocolVersion: 2,
    sourceRevision: T3_SOURCE_COMMIT, executorId: '11111111-1111-4111-8111-111111111111',
    environmentId: 'source:原文', connectionEpoch: '1', runtimeGeneration: 'writer:one',
    correlationId: 'attempt:one', relayOrdinal: 0, kind: 'request', method: 'orchestration.launchThread',
    commandId: 'command:one', input: { commandId: 'command:one', projectId: 'project:one', threadId: 'thread:one',
      title: 'Původní vlákno', modelSelection: { instanceId: 'codex', model: 'fixture-model' },
      runtimeMode: 'full-access', interactionMode: 'default', workspaceStrategy: { type: 'root' },
      initialMessage: { messageId: 'message:one', text: 'spusť původní příkaz', attachments: [] } } })
  const encoded = encodeExecutorT3LaneOperation(request)
  const requestSha256 = 'sha256:' + createHash('sha256').update(JSON.stringify(encoded)).digest('hex')
  const inspection = { version: 1, inspectionId: 'a'.repeat(64), issuerKeyId: 'b'.repeat(64), nonce: 'c'.repeat(64),
    executorId: request.executorId, environmentId: request.environmentId, connectionEpoch: '1',
    runtimeGeneration: request.runtimeGeneration, correlationId: request.correlationId, commandId: 'command:one',
    requestSha256, relayHmac: 'hmac-sha256:' + 'd'.repeat(64), actorReference: 'sha256:' + 'e'.repeat(64),
    initiationReference: 'sha256:' + 'f'.repeat(64), sourceRootKey: 'root:one', sourceGeneration: 'capture:one',
    sourceRevision: T3_SOURCE_COMMIT, targets: [], issuedAtMs: now, expiresAtMs: now + 5000 }
  const offer: T3LaneInspection = { inspectionId: inspection.inspectionId, request: encoded,
    inspection: { payload: JSON.stringify(inspection), keyId: 'fixture', signature: 'a'.repeat(86) },
    relayHmac: inspection.relayHmac, retentionExpiresAt: new Date(now + 20000).toISOString() }
  const runtime: T3InspectionRuntimeAnnouncement = { role: 'source-inspection', environmentId: request.environmentId,
    runtimeGeneration: request.runtimeGeneration, sourceRevision: T3_SOURCE_COMMIT,
    physicalRootKey: inspection.sourceRootKey, captureGeneration: inspection.sourceGeneration }
  const receipt = { domain: T3_EXECUTION_GRAPH_DOMAIN, payload: '{}',
    keyId: 'b'.repeat(64), signature: 'a'.repeat(86) }
  const accepted: T3LaneInspectionAccepted = { inspectionId: inspection.inspectionId, graphId: '1'.repeat(64),
    expiresAt: new Date(now + 12000).toISOString(),
    executorId: request.executorId, environmentId: request.environmentId,
    connectionEpoch: '1', runtimeGeneration: request.runtimeGeneration, sourceRevision: T3_SOURCE_COMMIT,
    physicalRootKey: runtime.physicalRootKey, captureGeneration: runtime.captureGeneration,
    correlationId: request.correlationId, commandId: 'command:one', requestSha256, relayHmac: inspection.relayHmac,
    receiptDigest: 'sha256:' + createHash('sha256').update(canonicalExecutorJson(receipt)).digest('hex') }
  return { request, offer, runtime, receipt, accepted }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('retained runtime cannot inspect or accidentally execute an inspection offer', async () => {
  let opened = false
  const pump = createT3InspectionPump({ describe: async () => [],
    async *open() { opened = true; throw new Error('Inspection must not execute') } })
  await assert.rejects(pump.accept('executor', '1', [], [{} as T3LaneInspection], [], [], 64),
    /T3_EXECUTION_INSPECTION_UNBOUND/u)
  assert.equal(opened, false)
  await pump.close()
})

test('inspection ACK cannot discard an unknown or unsent receipt', async () => {
  const f = fixture(Date.now())
  const pump = createT3InspectionPump({ describe: async () => [], async *open() {} })
  await assert.rejects(pump.accept(f.request.executorId, '1', [], [], [f.accepted], [], 64),
    /T3_INVALID_INSPECTION_ACK/u)
  await pump.close()
})

test('late accepted ACK preserves same graph signal, cannot extend parent, and joins release', async t => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const f = fixture(now)
  let parent: AbortSignal | undefined, accepts = 0, releases = 0, opened = false
  let finishRelease!: () => void
  const released = new Promise<void>(resolve => { finishRelease = resolve })
  const pump = createT3InspectionPump({ describe: async () => [],
    async inspect(_request, signal, delivery) {
      assert.equal(delivery.retentionExpiresAt, f.offer.retentionExpiresAt)
      parent = signal
      return f.receipt
    },
    async acceptInspection(_request, value, signal) {
      accepts++; assert.equal(signal, parent); assert.deepEqual(value, f.accepted)
    },
    async releaseInspection(id) { assert.equal(id, f.offer.inspectionId); releases++; await released },
    async *open() { opened = true },
  })
  await pump.accept(f.request.executorId, '1', [f.runtime], [f.offer], [], [], 64)
  await flush()
  const sent = pump.frames()
  assert.equal(sent.length, 1)
  t.mock.timers.tick(6000) // Challenge expired, but original admitted resource cap has not.
  assert.equal(parent?.aborted, false)
  assert.equal(pump.frames()[0], sent[0])
  await pump.accept(f.request.executorId, '1', [f.runtime], [], [f.accepted], sent, 64)
  assert.equal(parent?.aborted, false)
  assert.deepEqual(pump.frames(), [])
  assert.equal(pump.hasAccepted(f.request), true)
  assert.equal(pump.hasAccepted({ ...f.request, correlationId: 'different-attempt' }), false)
  await pump.accept(f.request.executorId, '1', [f.runtime], [], [f.accepted], [], 64)
  assert.equal(accepts, 1)
  await assert.rejects(pump.accept(f.request.executorId, '1', [f.runtime], [],
    [{ ...f.accepted, expiresAt: new Date(now + 19000).toISOString() }], [], 64), /REPLAY_CONFLICT/u)
  t.mock.timers.tick(6000)
  assert.equal(parent?.aborted, true)
  assert.equal(pump.hasAccepted(f.request), false)
  let closed = false
  const close = pump.close().then(() => { closed = true })
  await flush()
  assert.equal(closed, false)
  assert.equal(releases, 1)
  finishRelease()
  await close
  assert.equal(pump.size(), 0)
  assert.equal(opened, false)
})

test('ACK substitutions and missing cold availability never retain or reopen a graph', async () => {
  const f = fixture(Date.now())
  let parent: AbortSignal | undefined, releases = 0, accepts = 0
  const pump = createT3InspectionPump({ describe: async () => [],
    async inspect(_request, signal) { parent = signal; return f.receipt },
    async acceptInspection() { accepts++ }, async releaseInspection() { releases++ }, async *open() {},
  })
  await pump.accept(f.request.executorId, '1', [f.runtime], [f.offer], [], [], 64)
  await flush()
  const sent = pump.frames()
  for (const change of [{ receiptDigest: 'sha256:' + '0'.repeat(64) }, { runtimeGeneration: 'other' },
    { captureGeneration: 'other' }, { relayHmac: 'hmac-sha256:' + '0'.repeat(64) },
    { requestSha256: 'sha256:' + '0'.repeat(64) }, { expiresAt: new Date(Date.now() + 60000).toISOString() }]) {
    await assert.rejects(pump.accept(f.request.executorId, '1', [f.runtime], [],
      [{ ...f.accepted, ...change }], sent, 64), /T3_INVALID_INSPECTION_ACK/u)
  }
  assert.equal(accepts, 0)
  await pump.accept(f.request.executorId, '1', [], [], [], [], 64)
  assert.equal(parent?.aborted, true)
  assert.equal(releases, 1)
  await pump.close()
})
