import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable, Writable } from 'node:stream'
import { ProtectedRuntimeInputSchema, readProtectedRuntimeFrames, writeProtectedRuntimeFrame }
  from '../../dist/t3-session/runtime/protected-wire.js'

test('protected control frames decode complete UTF8 across arbitrary chunk boundaries', async () => {
  const bytes = Buffer.from('{"value":"Příliš žluťoučký"}\n{"value":"日本語"}\n')
  const values = []
  for await (const value of readProtectedRuntimeFrames(Readable.from([...bytes].map(byte => Buffer.from([byte]))),
    new AbortController().signal)) values.push(value)
  assert.deepEqual(values, [{ value: 'Příliš žluťoučký' }, { value: '日本語' }])
})

test('source selector cannot introduce paths, machine keys, raw stdin or process arguments', () => {
  const input = { type: 'source', admittedRootKey: 'registered-home' }
  assert.deepEqual(ProtectedRuntimeInputSchema.parse(input), input)
  for (const field of ['path', 'stateDirectory', 'machinePrivateKey', 'stdin', 'argv']) {
    assert.equal(ProtectedRuntimeInputSchema.safeParse({ ...input, [field]: 'injected' }).success, false)
  }
  assert.equal(ProtectedRuntimeInputSchema.safeParse({ type: 'spawn', command: 'anything' }).success, false)
})

test('partial EOF and invalid UTF8 never produce a control message', async () => {
  for (const bytes of [Buffer.from('{"type":"close"}'), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10])]) {
    await assert.rejects(async () => {
      for await (const _frame of readProtectedRuntimeFrames(Readable.from([bytes]), new AbortController().signal)) {
        assert.fail('invalid frame escaped')
      }
    })
  }
})

test('control write completion follows the actual Writable callback', async () => {
  const waiting = Promise.withResolvers()
  let acknowledged = false
  const output = new Writable({ write(_chunk, _encoding, done) { waiting.resolve(done) } })
  const sent = writeProtectedRuntimeFrame(output, { type: 'close' }).then(() => { acknowledged = true })
  const complete = await waiting.promise
  assert.equal(acknowledged, false)
  complete()
  await sent
  assert.equal(acknowledged, true)
  output.destroy()
})
