import assert from 'node:assert/strict'
import test from 'node:test'
import { createProtectedNativeRelay, createProtectedNativeClient }
  from '../../dist/t3-session/runtime/protected-native-relay.js'
import { ProtectedRuntimeOutputSchema } from '../../dist/t3-session/runtime/protected-wire.js'

const parent = () => new AbortController()
const phase = { phase: 'reserve', graphId: 'a'.repeat(64) }
const proof = { payload: '{ "exact": "signed string bytes" }', keyId: 'key', signature: 'signature' }
const unsupported = async () => { throw new Error('unexpected method') }

test('finite native relay preserves signed bytes and refuses replay of a consumed call ID', async () => {
  let observed, calls = 0
  const child = createProtectedNativeClient(async request => { observed = request; daemon.receive(request) })
  const daemon = createProtectedNativeRelay(async result => child.receive(result), () => assert.fail('relay failed'))
  const held = daemon.register({ phase: async () => { calls++; return proof },
    frame: unsupported, receipt: unsupported }, parent().signal)
  const local = child.open(held.operationId, parent().signal)
  assert.deepEqual(await local.port.phase(phase, parent().signal), proof)
  assert.equal(calls, 1)
  assert.throws(() => daemon.receive(observed), /REFUSED/u)
  await local.close()
  await held.close()
  assert.throws(() => daemon.receive(observed), /REFUSED/u)
  await child.close()
  await daemon.close()
})

test('operation close aborts HTTP demand and joins its actual unresolved result', async () => {
  const finished = Promise.withResolvers(), entered = Promise.withResolvers()
  let drained = false
  const daemon = createProtectedNativeRelay(async () => {}, () => assert.fail('unexpected failure'))
  const held = daemon.register({ phase: async (_input, signal) => {
    entered.resolve(signal)
    await finished.promise
    return proof
  }, frame: unsupported, receipt: unsupported }, parent().signal)
  daemon.receive({ type: 'native', operationId: held.operationId, callId: 'b'.repeat(64),
    operation: { operation: 'execution.phase', input: phase } })
  const signal = await entered.promise
  const closing = held.close().then(() => { drained = true })
  assert.equal(signal.aborted, true)
  await Promise.resolve()
  assert.equal(drained, false)
  finished.resolve()
  await closing
  assert.equal(drained, true)
  await daemon.close()
})

test('a response cannot cross captured operation ports or introduce raw selectors', async () => {
  const sent = []
  const child = createProtectedNativeClient(async value => { sent.push(value) })
  const one = child.open('1'.repeat(64), parent().signal), two = child.open('2'.repeat(64), parent().signal)
  const answer = one.port.phase(phase, parent().signal)
  void answer.catch(() => undefined)
  await Promise.resolve()
  assert.throws(() => child.receive({ type: 'native-result', operationId: '2'.repeat(64),
    callId: sent[0].callId, value: proof }), /REFUSED/u)
  for (const injected of [{ originalOperation: {} }, { bytes: 'raw' }, { binding: {} }, { machinePrivateKey: 'raw' }]) {
    assert.equal(ProtectedRuntimeOutputSchema.safeParse({ ...sent[0],
      operation: { ...sent[0].operation, ...injected } }).success, false)
  }
  await one.close()
  await assert.rejects(answer, /REFUSED/u)
  await two.close()
  await child.close()
})
