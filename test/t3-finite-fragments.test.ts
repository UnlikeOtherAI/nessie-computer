import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { decodeExecutorT3LaneOperation, decodeExecutorT3LaneReply, encodeExecutorT3LaneReply,
  encodeExecutorT3LaneOperation, T3_SOURCE_COMMIT, T3_FINITE_FRAGMENT_LIMITS,
  type T3LaneExchangeResult, type T3LaneFrame } from '@nessie/executor-protocol/t3-session'
import { createT3SessionLane } from '../src/t3-session-lane.js'
import { retainT3FiniteReply } from '../src/t3-finite-reply.js'

function fixture() {
  const keys = generateKeyPairSync('ed25519')
  const state = { executorId: randomUUID(), connectionEpoch: '1', apiBaseUrl: 'https://executor.test',
    machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') }
  const routing = { transportVersion: 1, protocolVersion: 2, sourceRevision: T3_SOURCE_COMMIT,
    executorId: state.executorId, environmentId: 'original:environment', connectionEpoch: '1',
    runtimeGeneration: 'held:runtime', correlationId: 'large-finite:one', relayOrdinal: 0 }
  const request = decodeExecutorT3LaneOperation({ ...routing, kind: 'request',
    method: 'orchestration.getThreadTitles', input: { threadIds: ['original:thread'] } })
  const reply = decodeExecutorT3LaneReply({ ...routing, kind: 'result',
    method: 'orchestration.getThreadTitles', result: { 'original:thread': 'é原🙂'.repeat(1_050_000) } })
  const announcement = { environmentId: routing.environmentId, runtimeGeneration: routing.runtimeGeneration,
    sourceRevision: T3_SOURCE_COMMIT, physicalRootKey: 'fixture:root', captureGeneration: 'fixture:capture',
    state: 'ready' as const }
  return { state, request, reply, announcement }
}

test('large original finite result is pulled once, held under credit and retried byte-exactly', async t => {
  const f = fixture()
  const frames: T3LaneFrame[] = []
  let opens = 0, first = true, lost = false, hold = true
  const expiry = new Date(Date.now() + 50_000).toISOString()
  const lane = createT3SessionLane({ describe: async () => [f.announcement],
    async *open() { opens++; yield f.reply } }, {
    exchangeT3SessionOperations: async (_base, input): Promise<T3LaneExchangeResult> => {
      if (first) {
        first = false
        return { acknowledged: [], controls: [], offers: [{ request: encodeExecutorT3LaneOperation(f.request),
          requestDigest: `hmac-sha256:${'a'.repeat(64)}`, expiresAt: expiry }] }
      }
      const frame = input.frames[0]
      if (!frame) return { acknowledged: [], offers: [], controls: [] }
      assert.equal(frame.reply, undefined)
      assert.ok(frame.fragment)
      assert.ok(Buffer.from(frame.fragment.data, 'base64').length <= T3_FINITE_FRAGMENT_LIMITS.bytes)
      if (!lost) { lost = true; frames.push(frame); throw new Error('lost-response') }
      if (frames.length === 1 && frame.ordinal === 0) assert.deepEqual(frame, frames[0])
      if (hold) { hold = false; return { acknowledged: [], offers: [], controls: [{ ...frame,
        state: 'hold', nextOrdinal: frame.ordinal, expiresAt: expiry }] } }
      if (frame.ordinal > 0) frames.push(frame)
      return { acknowledged: [{ ...frame, ordinal: frame.ordinal }], offers: [], controls: frame.final ? [] : [{
        environmentId: frame.environmentId, correlationId: frame.correlationId, state: 'credit',
        nextOrdinal: frame.ordinal + 1, expiresAt: expiry }] }
    },
  })
  t.after(() => lane.close())
  await lane.exchangeT3SessionOperations(f.state)
  await setImmediate()
  await assert.rejects(lane.exchangeT3SessionOperations(f.state), /lost-response/u)
  await lane.exchangeT3SessionOperations(f.state)
  for (let i = 0; i < 32 && lane.hot(); i++) {
    await lane.exchangeT3SessionOperations(f.state)
    await setImmediate()
  }
  assert.equal(lane.hot(), false)
  assert.equal(opens, 1)
  assert.ok(frames.length > 8)
  const actual = Buffer.concat(frames.map(frame => Buffer.from(frame.fragment!.data, 'base64')))
  const expected = Buffer.from(JSON.stringify(encodeExecutorT3LaneReply(f.reply)))
  assert.deepEqual(actual, expected)
  assert.equal(frames[0]!.fragment!.digest, 'sha256:' + createHash('sha256').update(actual).digest('hex'))
})

test('fragment buffers close idempotently and do not introduce a retained stream', () => {
  const f = fixture()
  const held = retainT3FiniteReply(f.request, encodeExecutorT3LaneReply(f.reply))!
  assert.ok(held)
  assert.equal(held.at(0).index, 0)
  assert.throws(() => held.at(-1), /T3_FINITE_FRAGMENT_ORDINAL/u)
  held.close(); held.close()
  assert.throws(() => held.at(0), /T3_FINITE_FRAGMENT_ORDINAL/u)
  const stream = decodeExecutorT3LaneOperation({ ...encodeExecutorT3LaneOperation(f.request),
    method: 'orchestration.subscribeThread', input: { threadId: 'original:thread' } })
  assert.throws(() => retainT3FiniteReply(stream, encodeExecutorT3LaneReply(f.reply)),
    /T3_FINITE_FRAGMENT_OPERATION_UNBOUND/u)
})
