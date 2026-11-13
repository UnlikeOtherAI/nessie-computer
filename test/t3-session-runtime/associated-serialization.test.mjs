import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import { EffectCommand, CodexErrors } from '@nessie/t3-session-source/engine'
import { createProtectedCodexSerialization } from '../../dist/t3-session/runtime/codex-serialization.js'
import { createProtectedProviderSerialization } from '../../dist/t3-session/runtime/provider-serialization.js'
import { providerFrameFixture } from './provider-frame-fixture.mjs'

const encoded = '{"id":7,"method":"turn/start","params":{"input":[{"text":"日本語"}]}}\n'
const fixture = async (options = {}) => {
  const f = await providerFrameFixture(), calls = []
  const provider = { stageEffectFrame: async (bytes, metadata, context) => {
    calls.push({ stage: Buffer.from(bytes), metadata, context }); return '1'.repeat(64)
  }, commitEffectFrame: async (frameId, proof) => {
    calls.push({ commit: frameId, proof }); await options.ack?.()
  }, prepareFrame: async () => assert.fail('bootstrap cannot be reopened'),
  refuseProviderRequest: async id => { calls.push({ negative: id }) } }
  const transport = { effect: async signal => {
    calls.push({ effect: true, signal }); return options.proof ? options.proof(f) : f.proof()
  } }
  const serialization = createProtectedCodexSerialization(provider, transport, f.descriptor,
    f.preparation, AbortSignal.any([f.parent.signal, f.lineage.signal]), f.lineage)
  await serialization.finishBootstrap()
  serialization.acceptAssociation(f.receipt)
  const captureEffect = (value = encoded, effect = f.originalEffect) =>
    serialization.output.capture(value).pipe(Effect.provideService(EffectCommand.OriginalEffectCommandContext, effect))
  const capture = (...args) => Effect.runPromise(captureEffect(...args))
  return { ...f, calls, serialization, capture, captureEffect }
}
const assertRefused = async effect => {
  const result = await Effect.runPromise(effect.pipe(Effect.result))
  assert.equal(result._tag, 'Failure')
  assert.ok(result.failure instanceof CodexErrors.CodexAppServerTransportError)
}

test('associated original Codex bytes retain their command before queue and await native commit acknowledgement', async () => {
  const ack = Promise.withResolvers(), committed = Promise.withResolvers()
  const f = await fixture({ ack: async () => { committed.resolve(); await ack.promise } })
  try {
    const captured = await f.capture()
    assert.deepEqual(f.calls, [], 'capture must precede both staging and permit issuance')
    f.originalEffect.commandId = 'later-command'
    f.originalEffect.runId = 'later-run'
    let written = false
    const writing = Effect.runPromise(captured.write).then(() => { written = true })
    await committed.promise
    assert.equal(written, false)
    assert.deepEqual(f.calls.map(call => Object.keys(call)[0]), ['stage', 'effect', 'commit'])
    assert.equal(f.calls[0].stage.toString(), encoded)
    assert.deepEqual(f.calls[0].context, { correlationId: f.preparation.binding.correlationId,
      commandId: f.preparation.binding.commandId, requestDigest: f.preparation.binding.relayHmac,
      providerSessionId: f.preparation.providerSessionId })
    ack.resolve(); await writing
    assert.equal(written, true)
    await assertRefused(captured.write)
    await Effect.runPromise(captured.discard)
  } finally { f.lineage.close(); await f.serialization.close() }
})

test('associated capture refuses absent, substituted or retired original effect metadata before staging', async () => {
  for (const mode of ['missing', 'command', 'run', 'thread', 'retired']) {
    const f = await fixture()
    try {
      const actual = { ...f.originalEffect }
      if (mode === 'command') actual.commandId = 'another-command'
      if (mode === 'run') actual.runId = 'another-run'
      if (mode === 'thread') actual.threadId = 'another-thread'
      if (mode === 'retired') f.lineage.close()
      await assertRefused(mode === 'missing' ? f.serialization.output.capture(encoded)
        : f.captureEffect(encoded, actual))
      assert.deepEqual(f.calls, [])
    } finally { f.lineage.close(); await f.serialization.close() }
  }
})

test('association and current proof must match the held provider; refusal permanently closes captured input', async () => {
  const f = await fixture({ proof: current => ({ ...current.proof(), grant: {
    ...current.proof().grant, providerSessionId: 'unrelated-session',
  } }) })
  try {
    const captured = await f.capture()
    await assertRefused(captured.write)
    assert.deepEqual(f.calls.map(call => Object.keys(call)[0]), ['stage', 'effect'])
    await assertRefused(f.captureEffect())
    assert.throws(() => f.serialization.acceptAssociation(f.receipt), { name: 'AbortError' })
  } finally { f.lineage.close(); await f.serialization.close() }
})

test('lineage retirement revokes an already queued frame before any native stage or effect request', async () => {
  const f = await fixture()
  const captured = await f.capture()
  f.lineage.close()
  assert.equal(f.lineage.signal.aborted, true)
  await assertRefused(captured.write)
  assert.deepEqual(f.calls, [])
  await Effect.runPromise(captured.discard)
  await f.serialization.close()
})

test('a queued bootstrap frame cannot acquire associated authority after the phase handoff', async () => {
  const f = await providerFrameFixture()
  const unexpected = () => assert.fail('a discarded bootstrap frame must never reach native or HTTP')
  const serialization = createProtectedProviderSerialization({ prepareFrame: unexpected,
    stageEffectFrame: unexpected }, { frame: unexpected, effect: unexpected },
  f.descriptor, f.preparation, f.parent.signal)
  try {
    const captured = serialization.capture(encoded)
    await serialization.finishBootstrap()
    serialization.acceptAssociation(f.receipt)
    assert.throws(() => captured.write(f.parent.signal), /REFUSED/u)
    assert.throws(() => serialization.capture(encoded), /REFUSED/u)
    await captured.discard()
  } finally { f.lineage.close(); await serialization.close() }
})
