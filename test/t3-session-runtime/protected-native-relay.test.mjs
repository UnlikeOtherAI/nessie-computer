import assert from 'node:assert/strict'
import test from 'node:test'
import { createProtectedNativeRelay, createProtectedNativeClient }
  from '../../dist/t3-session/runtime/protected-native-relay.js'
import { ProtectedRuntimeOutputSchema } from '../../dist/t3-session/runtime/protected-wire.js'
import { providerFrameFixture } from './provider-frame-fixture.mjs'

const parent = () => new AbortController()
const phase = { phase: 'reserve', graphId: 'a'.repeat(64) }
const proof = { payload: '{ "exact": "signed string bytes" }', keyId: 'key', signature: 'signature' }
const unsupported = async () => { throw new Error('unexpected method') }
// Transport-shape fixture only; these bytes cannot authorize a native read.
const secretRead = { preparationReceipt: { domain: 'nessie.t3.execution.secret-read-preparation.v1',
  keyId: 'c'.repeat(64), payload: '{ "observed": "exact preparation bytes" }', signature: 'd'.repeat(86) } }
const legacyShells = { preparationReceipt: { ...secretRead.preparationReceipt,
  domain: 'nessie.t3.execution.legacy-shell-preparation.v1' } }
const prepareShutdown = { preparationReceipt: { ...secretRead.preparationReceipt,
  domain: 'nessie.t3.execution.shutdown-preparation.v1' } }

test('shutdown relay uses the captured operation port and preserves exact signed bytes without accepting selectors', async () => {
  let calls = 0
  const stop = parent()
  const child = createProtectedNativeClient(async request => daemon.receive(request))
  const daemon = createProtectedNativeRelay(async result => child.receive(result), () => assert.fail('relay failed'))
  const held = daemon.register({ phase: unsupported, frame: unsupported, secretRead: unsupported,
    preclaim: unsupported, legacyShells: unsupported, effect: unsupported, receipt: unsupported,
    prepareShutdown: async input => { calls++; assert.deepEqual(input, prepareShutdown); return proof } }, stop.signal)
  const local = child.open(held.operationId, stop.signal)
  assert.deepEqual(await local.port.prepareShutdown(prepareShutdown, stop.signal), proof)
  assert.equal(calls, 1)
  assert.equal(ProtectedRuntimeOutputSchema.safeParse({ type: 'native', operationId: held.operationId,
    callId: 'a'.repeat(64), operation: { operation: 'execution.prepareShutdown',
      input: { ...prepareShutdown, effects: [] } } }).success, false)
  await local.close()
  await held.close()
  await child.close()
  await daemon.close()
})

test('shell relay uses only its captured port, preserves exact bytes and refuses call replay or retired demand', async () => {
  let observed, calls = 0
  const stop = parent()
  const child = createProtectedNativeClient(async request => { observed = request; daemon.receive(request) })
  const daemon = createProtectedNativeRelay(async result => child.receive(result), () => assert.fail('relay failed'))
  const held = daemon.register({ phase: unsupported, frame: unsupported, secretRead: unsupported,
    preclaim: unsupported, prepareShutdown: unsupported, effect: unsupported, receipt: unsupported,
    legacyShells: async input => {
      calls++; assert.deepEqual(input, legacyShells); return proof
    } }, stop.signal)
  const local = child.open(held.operationId, stop.signal)
  assert.deepEqual(await local.port.legacyShells(legacyShells, stop.signal), proof)
  assert.deepEqual(observed.operation, { operation: 'execution.legacyShells', input: legacyShells })
  assert.throws(() => daemon.receive(observed), /REFUSED/u)
  assert.equal(ProtectedRuntimeOutputSchema.safeParse({ ...observed, operation: {
    operation: 'execution.legacyShells', input: { ...legacyShells, targets: [] } } }).success, false)
  await local.close(); await held.close()
  await assert.rejects(local.port.legacyShells(legacyShells, stop.signal))
  assert.equal(calls, 1)
  await child.close(); await daemon.close()
})

test('finite native relay preserves signed bytes and refuses replay of a consumed call ID', async () => {
  let observed, calls = 0
  const child = createProtectedNativeClient(async request => { observed = request; daemon.receive(request) })
  const daemon = createProtectedNativeRelay(async result => child.receive(result), () => assert.fail('relay failed'))
  const held = daemon.register({ phase: async () => { calls++; return proof },
    frame: unsupported, secretRead: unsupported, preclaim: unsupported, receipt: unsupported }, parent().signal)
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
  }, frame: unsupported, secretRead: unsupported, preclaim: unsupported, receipt: unsupported }, parent().signal)
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

test('secretRead stays on its captured port and preserves exact receipt and signed payload strings', async () => {
  let observed, calls = 0
  const stop = parent()
  const child = createProtectedNativeClient(async request => { observed = request; daemon.receive(request) })
  const daemon = createProtectedNativeRelay(async result => child.receive(result), () => assert.fail('relay failed'))
  const held = daemon.register({ phase: unsupported, frame: unsupported, receipt: unsupported,
    secretRead: async (input, signal) => {
      calls++
      assert.deepEqual(input, secretRead)
      assert.equal(signal.aborted, false)
      return proof
    } }, stop.signal)
  const other = daemon.register({ phase: unsupported, frame: unsupported,
    secretRead: unsupported, preclaim: unsupported, receipt: unsupported }, parent().signal)
  const local = child.open(held.operationId, stop.signal)
  assert.deepEqual(await local.port.secretRead(secretRead, stop.signal), proof)
  assert.equal(observed.operationId, held.operationId)
  assert.equal(observed.operation.operation, 'execution.secretRead')
  assert.equal(observed.operation.input.preparationReceipt.payload, secretRead.preparationReceipt.payload)
  assert.equal(calls, 1)
  assert.throws(() => daemon.receive(observed), /REFUSED/u)
  for (const injected of [{ value: 'raw' }, { reference: 'caller-selected' }, { binding: {} }, { request: {} }]) {
    assert.equal(ProtectedRuntimeOutputSchema.safeParse({ ...observed, operation: { ...observed.operation,
      input: { ...secretRead, ...injected } } }).success, false)
  }
  await local.close(); await held.close(); await other.close()
  await child.close(); await daemon.close()
})

test('secretRead refusal terminates the captured operation without retry or renewed observation', async () => {
  let observed, calls = 0
  const stop = parent()
  const child = createProtectedNativeClient(async request => { observed = request; daemon.receive(request) })
  const daemon = createProtectedNativeRelay(async result => child.receive(result), () => assert.fail('relay failed'))
  const held = daemon.register({ phase: unsupported, frame: unsupported, receipt: unsupported,
    secretRead: async () => { calls++; throw new Error('unavailable native observation') } }, stop.signal)
  const local = child.open(held.operationId, stop.signal)
  await assert.rejects(local.port.secretRead(secretRead, stop.signal), /REFUSED/u)
  await assert.rejects(local.port.secretRead(secretRead, stop.signal))
  assert.throws(() => daemon.receive({ ...observed, callId: 'e'.repeat(64) }), /REFUSED/u)
  assert.equal(calls, 1)
  await local.close(); await held.close(); await child.close(); await daemon.close()
})

test('secretRead operation cancellation joins the original HTTP demand and refuses fresh calls', async () => {
  const finished = Promise.withResolvers(), entered = Promise.withResolvers()
  let drained = false, calls = 0
  const daemon = createProtectedNativeRelay(async () => {}, () => assert.fail('unexpected failure'))
  const held = daemon.register({ phase: unsupported, frame: unsupported, receipt: unsupported,
    secretRead: async (_input, signal) => {
      calls++
      entered.resolve(signal)
      await finished.promise
      return proof
    } }, parent().signal)
  const request = { type: 'native', operationId: held.operationId, callId: 'f'.repeat(64),
    operation: { operation: 'execution.secretRead', input: secretRead } }
  daemon.receive(request)
  const signal = await entered.promise
  const closing = held.close().then(() => { drained = true })
  assert.equal(signal.aborted, true)
  await Promise.resolve()
  assert.equal(drained, false)
  assert.throws(() => daemon.receive({ ...request, callId: '1'.repeat(64) }), /REFUSED/u)
  finished.resolve()
  await closing
  assert.equal(drained, true)
  assert.equal(calls, 1)
  await daemon.close()
})

const preclaim = { preparationReceipt: { ...secretRead.preparationReceipt,
  domain: 'nessie.t3.execution.sql-preclaim-preparation.v1', payload: '{ "exact": "original row evidence" }' } }

test('preclaim uses the exact captured port and bytes; selector injection and call replay are refused', async () => {
  let observed, calls = 0
  const stop = parent()
  const child = createProtectedNativeClient(async request => { observed = request; daemon.receive(request) })
  const daemon = createProtectedNativeRelay(async result => child.receive(result), () => assert.fail('relay failed'))
  const held = daemon.register({ phase: unsupported, frame: unsupported, secretRead: unsupported,
    receipt: unsupported, preclaim: async input => {
      calls++; assert.deepEqual(input, preclaim); return proof
    } }, stop.signal)
  const local = child.open(held.operationId, stop.signal)
  assert.deepEqual(await local.port.preclaim(preclaim, stop.signal), proof)
  assert.equal(observed.operation.operation, 'execution.preclaim')
  assert.equal(observed.operationId, held.operationId)
  assert.equal(observed.operation.input.preparationReceipt.payload, preclaim.preparationReceipt.payload)
  assert.equal(calls, 1)
  assert.throws(() => daemon.receive(observed), /REFUSED/u)
  for (const field of ['sql', 'effectId', 'attemptCount', 'rowDigest', 'binding', 'expiresAtMs']) {
    assert.equal(ProtectedRuntimeOutputSchema.safeParse({ ...observed, operation: { ...observed.operation,
      input: { ...preclaim, [field]: 'injected' } } }).success, false)
  }
  await local.close(); await held.close(); await child.close(); await daemon.close()
})

test('uncertain preclaim refusal is terminal and never retries the original port', async () => {
  let calls = 0
  const stop = parent()
  const child = createProtectedNativeClient(async request => daemon.receive(request))
  const daemon = createProtectedNativeRelay(async result => child.receive(result), () => assert.fail('relay failed'))
  const held = daemon.register({ phase: unsupported, frame: unsupported, secretRead: unsupported,
    receipt: unsupported, preclaim: async () => { calls++; throw new Error('uncertain preclaim') } }, stop.signal)
  const local = child.open(held.operationId, stop.signal)
  await assert.rejects(local.port.preclaim(preclaim, stop.signal), /REFUSED/u)
  await assert.rejects(local.port.preclaim(preclaim, stop.signal))
  assert.equal(calls, 1)
  await local.close(); await held.close(); await child.close(); await daemon.close()
})

test('closing a preclaim port aborts and joins its original HTTP demand before release', async () => {
  const entered = Promise.withResolvers(), finished = Promise.withResolvers()
  let drained = false
  const daemon = createProtectedNativeRelay(async () => {}, () => assert.fail('relay failed'))
  const held = daemon.register({ phase: unsupported, frame: unsupported, secretRead: unsupported,
    receipt: unsupported, preclaim: async (_input, signal) => {
      entered.resolve(signal); await finished.promise; return proof
    } }, parent().signal)
  daemon.receive({ type: 'native', operationId: held.operationId, callId: 'a'.repeat(64),
    operation: { operation: 'execution.preclaim', input: preclaim } })
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

test('effect relay uses only the captured port and refuses selectors, replay and a retired port', async () => {
  const f = await providerFrameFixture(), checked = f.proof()
  let observed, calls = 0
  const stop = parent()
  const child = createProtectedNativeClient(async request => { observed = request; daemon.receive(request) })
  const daemon = createProtectedNativeRelay(async result => child.receive(result), () => assert.fail('relay failed'))
  const held = daemon.register({ phase: unsupported, frame: unsupported, secretRead: unsupported,
    preclaim: unsupported, receipt: unsupported, effect: async signal => {
      assert.equal(signal.aborted, false); calls++; return checked
    } }, stop.signal)
  const local = child.open(held.operationId, stop.signal)
  assert.deepEqual(await local.port.effect(stop.signal), checked)
  assert.deepEqual(observed.operation, { operation: 'execution.effect' })
  assert.equal(observed.operationId, held.operationId)
  assert.throws(() => daemon.receive(observed), /REFUSED/u)
  for (const injected of [{ selection: checked.grant }, { input: {} }, { commandId: 'other' }]) {
    assert.equal(ProtectedRuntimeOutputSchema.safeParse({ ...observed,
      operation: { ...observed.operation, ...injected } }).success, false)
  }
  await local.close(); await held.close()
  await assert.rejects(local.port.effect(stop.signal))
  assert.equal(calls, 1)
  await child.close(); await daemon.close(); f.lineage.close()
})

test('closing an effect port aborts and joins its actual demand before releasing the association', async () => {
  const f = await providerFrameFixture(), entered = Promise.withResolvers(), finished = Promise.withResolvers()
  let drained = false
  const daemon = createProtectedNativeRelay(async () => {}, () => assert.fail('relay failed'))
  const held = daemon.register({ phase: unsupported, frame: unsupported, secretRead: unsupported,
    preclaim: unsupported, receipt: unsupported, effect: async signal => {
      entered.resolve(signal); await finished.promise; return f.proof()
    } }, parent().signal)
  daemon.receive({ type: 'native', operationId: held.operationId, callId: 'c'.repeat(64),
    operation: { operation: 'execution.effect' } })
  const signal = await entered.promise
  const closing = held.close().then(() => { drained = true })
  assert.equal(signal.aborted, true)
  await Promise.resolve()
  assert.equal(drained, false)
  finished.resolve(); await closing
  assert.equal(drained, true)
  await daemon.close(); f.lineage.close()
})
