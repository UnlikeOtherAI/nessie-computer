import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { canonicalExecutorPayload, RetainedImportLeaseSchema } from '@nessie/executor-protocol'
import { decodeExecutorT3LaneOperation, encodeExecutorT3LaneOperation, decodeExecutorT3LaneReply, T3_SOURCE_COMMIT,
  isRetainedT3LaneOperation,
  type T3LaneExchange, type T3LaneExchangeResult } from '@nessie/executor-protocol/t3-session'
import { createT3SessionLane } from '../src/t3-session-lane.js'
import { snapshotT3LaneDelivery, t3LaneDeliveryExpiry } from '../src/t3-session-delivery.js'

const fixture = () => {
  const keys = generateKeyPairSync('ed25519')
  const state = { executorId: randomUUID(), connectionEpoch: '1', apiBaseUrl: 'https://executor.test',
    machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') }
  const routing = { transportVersion: 1, protocolVersion: 2, sourceRevision: T3_SOURCE_COMMIT,
    executorId: state.executorId, environmentId: 'original:environment', connectionEpoch: '1',
    runtimeGeneration: 'held:runtime', correlationId: 'demand:one', relayOrdinal: 0 }
  const wire = { ...routing, kind: 'request', method: 'orchestration.subscribeThread',
    input: { threadId: 'original:thread' } }
  const request = decodeExecutorT3LaneOperation(wire)
  const reply = decodeExecutorT3LaneReply({ ...routing, kind: 'stream', method: 'orchestration.subscribeThread',
    result: { kind: 'synchronized' } })
  const announcement = { environmentId: routing.environmentId, runtimeGeneration: routing.runtimeGeneration,
    sourceRevision: T3_SOURCE_COMMIT, physicalRootKey: 'fixture:root', captureGeneration: 'fixture:capture',
    state: 'ready' as const }
  return { keys, state, wire: encodeExecutorT3LaneOperation(request), request, reply, announcement }
}

test('lost exchange response retries identical signed frame; credits alone advance original stream demand', async () => {
  const f = fixture()
  let pulls = 0
  let closed = false
  let response: (input: T3LaneExchange) => T3LaneExchangeResult = () => ({
    offers: [{ request: f.wire, requestDigest: `hmac-sha256:${'a'.repeat(64)}`,
      expiresAt: new Date(Date.now() + 50_000).toISOString() }], acknowledged: [], controls: [],
  })
  const sent: T3LaneExchange[] = []
  const lane = createT3SessionLane({ describe: async () => [f.announcement], async *open(_request, signal) {
    try { while (!signal.aborted) { pulls++; yield f.reply } } finally { closed = true }
  } }, { exchangeT3SessionOperations: async (_base, input) => {
    const { signature, ...payload } = input
    assert.equal(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.t3_operations.v1', payload)),
      f.keys.publicKey, Buffer.from(signature, 'base64url')), true)
    sent.push(structuredClone(input))
    return response(input)
  } })
  await lane.exchangeT3SessionOperations(f.state)
  await setImmediate()
  assert.equal(pulls, 1)
  response = () => { throw new Error('lost HTTP response') }
  await assert.rejects(lane.exchangeT3SessionOperations(f.state), /lost HTTP/)
  response = input => ({ offers: [], acknowledged: input.frames.map(frame => ({
    environmentId: frame.environmentId, correlationId: frame.correlationId, ordinal: frame.ordinal,
  })), controls: [{ environmentId: f.request.environmentId, correlationId: f.request.correlationId,
    state: 'hold', nextOrdinal: 1, expiresAt: new Date(Date.now() + 50_000).toISOString() }] })
  await lane.exchangeT3SessionOperations(f.state)
  assert.deepEqual(sent[1]!.frames, sent[2]!.frames)
  assert.equal(pulls, 1, 'HTTP acknowledgement does not grant another original stream pull')
  response = () => ({ offers: [], acknowledged: [], controls: [{ environmentId: f.request.environmentId,
    correlationId: f.request.correlationId, state: 'credit', nextOrdinal: 1,
    expiresAt: new Date(Date.now() + 50_000).toISOString() }] })
  await lane.exchangeT3SessionOperations(f.state)
  await setImmediate()
  assert.equal(pulls, 2)
  lane.close()
  await setImmediate()
  assert.equal(closed, true)
})

test('epoch change discards old demand without dispatching it twice', async () => {
  const f = fixture()
  let calls = 0
  let aborted = false
  const lane = createT3SessionLane({ describe: async () => [f.announcement], async *open(_request, signal) {
    calls++
    signal.addEventListener('abort', () => { aborted = true }, { once: true })
    yield f.reply
  } }, { exchangeT3SessionOperations: async (_base, input) => ({ acknowledged: [], controls: [],
    offers: input.connectionEpoch === '1' ? [{ request: f.wire,
      requestDigest: `hmac-sha256:${'a'.repeat(64)}`, expiresAt: new Date(Date.now() + 50_000).toISOString() }] : [],
  }) })
  await lane.exchangeT3SessionOperations(f.state)
  await setImmediate()
  await lane.exchangeT3SessionOperations(f.state)
  assert.equal(calls, 1)
  await lane.exchangeT3SessionOperations({ ...f.state, connectionEpoch: '2' })
  assert.equal(aborted, true)
  assert.equal(lane.hot(), false)
  lane.close()
})

test('authenticated offer carries original provenance separately and refuses changed initiation on replay', async t => {
  const f = fixture()
  const provenance = { createdBy: 'agent', creationSource: 'mcp' } as const
  const requestDigest = `hmac-sha256:${'b'.repeat(64)}`
  let calls = 0
  let offer: T3LaneExchangeResult['offers'][number] = { request: f.wire, provenance, requestDigest,
    expiresAt: new Date(Date.now() + 50_000).toISOString() }
  const lane = createT3SessionLane({ describe: async () => [f.announcement], async *open(request, _signal, delivery) {
    calls++
    assert.deepEqual(request, f.request)
    assert.deepEqual(delivery, { requestDigest, provenance })
    assert.equal(Object.isFrozen(delivery), true)
    assert.equal(Object.isFrozen(delivery.provenance), true)
    yield f.reply
  } }, { exchangeT3SessionOperations: async () => ({ acknowledged: [], controls: [], offers: [offer] }) })
  t.after(() => { lane.close() })
  await lane.exchangeT3SessionOperations(f.state)
  await setImmediate()
  await lane.exchangeT3SessionOperations(f.state)
  assert.equal(calls, 1)
  offer = { ...offer, provenance: { createdBy: 'user', creationSource: 'web' } }
  await assert.rejects(lane.exchangeT3SessionOperations(f.state), /T3_LANE_CORRELATION/u)
  assert.equal(calls, 1)
})

function catalogDelivery(f: ReturnType<typeof fixture>) {
  const requestDigest = `hmac-sha256:${'a'.repeat(64)}`
  const lease = RetainedImportLeaseSchema.parse({ executorId: f.state.executorId,
    environmentId: f.request.environmentId, physicalRootKey: 'physical:root', admittedRootKey: 'admitted:root',
    databaseIdentity: 'database:one', environmentIdentity: 'environment:one', captureGeneration: 'capture:one',
    leaseId: randomUUID(), token: 'b'.repeat(43), grantId: randomUUID(), generation: randomUUID(),
    sourceOwnerGeneration: 'c'.repeat(64), localApprovalId: 'd'.repeat(64),
    selection: { kind: 'threads', threadIds: ['original:thread'], projectIds: [] }, purpose: 'catalog',
    expiresAt: new Date(Date.now() + 20_000).toISOString(), basis: 'prospective_import',
    legacyCopyProvenance: 'not_attested_by_original_source', selectionKey: 'e'.repeat(64),
    operationBinding: { requestDigest: createHash('sha256').update(JSON.stringify(f.wire)).digest('hex'),
      relayRequestDigest: requestDigest, correlationId: f.request.correlationId,
      scope: { kind: 'thread', threadId: 'original:thread' } } })
  return { requestDigest, catalogLeases: [lease] }
}

test('held retained readiness never implies stream, mutation or conditional refresh implementation', () => {
  const f = fixture()
  assert.equal(isRetainedT3LaneOperation(f.request), false)
  const finite = decodeExecutorT3LaneOperation({ ...f.wire, method: 'orchestration.getThreadTitles',
    input: { threadIds: ['original:thread'] } })
  assert.equal(isRetainedT3LaneOperation(finite), true)
  // Intentionally structural negative input: this inventory does not decode or
  // grant a request. Production always runs the original codec before it.
  for (const method of ['vcs.listRefs', 'orchestration.dispatchCommand', 'orchestration.launchThread']) {
    assert.equal(isRetainedT3LaneOperation({ ...finite, method } as typeof finite), false)
  }
})

test('catalog descriptors are copied, deeply frozen and never extended by lane credits', () => {
  const f = fixture()
  const raw = catalogDelivery(f)
  const delivery = snapshotT3LaneDelivery(raw, f.request)
  assert.deepEqual(delivery, raw)
  assert.notEqual(delivery.catalogLeases![0], raw.catalogLeases[0])
  assert.equal(Object.isFrozen(delivery.catalogLeases![0]!.operationBinding), true)
  assert.equal(Object.isFrozen(delivery.catalogLeases![0]!.selection), true)
  assert.throws(() => { delivery.catalogLeases![0]!.token = 'f'.repeat(43) }, TypeError)
  const expiry = Date.parse(raw.catalogLeases[0]!.expiresAt)
  assert.equal(t3LaneDeliveryExpiry(delivery, expiry + 10_000), expiry)
  assert.equal(t3LaneDeliveryExpiry(delivery, expiry - 1000), expiry - 1000)
})

test('expired, substituted, bootstrap and duplicate catalog descriptors fail before runtime demand', () => {
  const f = fixture()
  const raw = catalogDelivery(f)
  const lease = raw.catalogLeases[0]!
  const reject = (patch: Partial<typeof lease>) => assert.throws(() =>
    snapshotT3LaneDelivery({ ...raw, catalogLeases: [{ ...lease, ...patch }] }, f.request))
  reject({ expiresAt: new Date(Date.now() - 1).toISOString() })
  reject({ expiresAt: new Date(Date.now() + 120_000).toISOString() })
  reject({ purpose: 'publish' })
  reject({ operationBinding: undefined })
  reject({ environmentId: 'other:environment' })
  reject({ operationBinding: { ...lease.operationBinding!, relayRequestDigest: `hmac-sha256:${'f'.repeat(64)}` } })
  assert.throws(() => snapshotT3LaneDelivery({ ...raw, catalogLeases: [lease, lease] }, f.request))
  assert.throws(() => snapshotT3LaneDelivery({ ...raw, catalogLeases: [] }, f.request))
})

test('same active offer retains catalog descriptor; replacement token cannot restart demand', async t => {
  const f = fixture()
  const delivery = catalogDelivery(f)
  let offer = { ...delivery, request: f.wire, expiresAt: new Date(Date.now() + 30_000).toISOString() }
  let calls = 0
  const lane = createT3SessionLane({ describe: async () => [f.announcement], async *open(_request, _signal, actual) {
    calls++
    assert.deepEqual(actual, delivery)
    yield f.reply
  } }, { exchangeT3SessionOperations: async () => ({ acknowledged: [], controls: [], offers: [offer] }) })
  t.after(() => { lane.close() })
  await lane.exchangeT3SessionOperations(f.state)
  await setImmediate()
  await lane.exchangeT3SessionOperations(f.state)
  assert.equal(calls, 1)
  offer = { ...offer, catalogLeases: [{ ...delivery.catalogLeases[0]!, token: 'f'.repeat(43) }] }
  await assert.rejects(lane.exchangeT3SessionOperations(f.state), /T3_LANE_CORRELATION/u)
  assert.equal(calls, 1)
})
