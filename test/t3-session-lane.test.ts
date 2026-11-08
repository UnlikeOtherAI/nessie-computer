import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { canonicalExecutorPayload } from '@nessie/executor-protocol'
import { decodeExecutorT3LaneOperation, encodeExecutorT3LaneOperation, decodeExecutorT3LaneReply, T3_SOURCE_COMMIT,
  type T3LaneExchange, type T3LaneExchangeResult } from '@nessie/executor-protocol/t3-session'
import { createT3SessionLane } from '../src/t3-session-lane.js'

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
  return { keys, state, wire: encodeExecutorT3LaneOperation(request), request, reply }
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
  const lane = createT3SessionLane({ describe: async () => [], async *open(_request, signal) {
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
  const lane = createT3SessionLane({ describe: async () => [], async *open(_request, signal) {
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
