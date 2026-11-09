import assert from 'node:assert/strict'
import test from 'node:test'
import { T3ExecutionDestinationReceiptSchema, T3ExecutionDestinationFileReceiptSchema } from '@nessie/executor-protocol'
import { withNativeExecutionDestination, recognizeT3ExecutionDestination }
  from '../../dist/t3-session/source/execution-destination.js'
import { withPinnedExecutionWorkspace } from '../../dist/t3-session/runtime/capture-workspace.js'

const resource = { resourceId: 'a'.repeat(64), resourceGeneration: `sha256:${'b'.repeat(64)}` }
const receipt = { ...resource, version: 1, runtimeGeneration: `destination-sha256:${'c'.repeat(64)}`,
  directoryIdentity: 'component-directory', writerIdentity: 'component-writer' }
const directory = '\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\component'
// Metadata transport double only. Real handle transfer/SQLite are covered by
// native component tests; no synthetic scope supplies native/backend authority.
const fixture = (override = () => undefined) => {
  const calls = []
  const exchange = message => {
    calls.push(message)
    const replaced = override(message)
    if (replaced !== undefined) return replaced
    if (message.op === 'executionDestinationOpen') return { receipt, directory }
    if (message.op === 'executionDestinationHoldFile') return { receipt: { version: 1,
      runtimeGeneration: receipt.runtimeGeneration, reference: message.reference, databaseIdentity: 'component-file' } }
    return {}
  }
  return { calls, exchange }
}

test('a serialized native destination cannot open storage or call a replacement recheck', async () => {
  let invoked = false
  const fake = { receipt, directory, signal: new AbortController().signal, recheck() { invoked = true } }
  assert.throws(() => recognizeT3ExecutionDestination(fake), /not_issued/u)
  await assert.rejects(withPinnedExecutionWorkspace(fake, async () => { invoked = true }, fake.signal), /not_issued/u)
  assert.equal(invoked, false)
})

test('local native destination scope keeps the exact owner and refuses escaped/file-selector use', async () => {
  const { calls, exchange } = fixture()
  let escaped
  await withNativeExecutionDestination(exchange, resource, new AbortController().signal, async scope => {
    escaped = scope
    recognizeT3ExecutionDestination(scope)
    assert.equal(scope.directory, directory)
    assert.equal(scope.receipt.runtimeGeneration, receipt.runtimeGeneration)
    scope.holdFile('journal')
    scope.holdFile(`t3-capture:v1:${'d'.repeat(64)}`)
    assert.throws(() => scope.holdFile('../source.sqlite'), /reference_invalid/u)
  })
  assert.equal(calls.filter(call => call.op === 'executionDestinationHoldFile').length, 2)
  assert.equal(calls.at(-1).op, 'executionDestinationClose')
  assert.throws(() => recognizeT3ExecutionDestination(escaped), /not_issued/u)
  assert.throws(() => escaped.directory)
})

test('destination schemas and the private transport refuse injected paths and replaced writer generations', async () => {
  assert.equal(T3ExecutionDestinationReceiptSchema.safeParse({ ...receipt, path: 'C:\\caller' }).success, false)
  assert.equal(T3ExecutionDestinationFileReceiptSchema.safeParse({ version: 1,
    runtimeGeneration: receipt.runtimeGeneration, reference: '../source', databaseIdentity: 'component' }).success, false)
  const wrongResource = fixture(message => message.op === 'executionDestinationOpen'
    ? { receipt: { ...receipt, resourceId: 'e'.repeat(64) }, directory } : undefined)
  await assert.rejects(withNativeExecutionDestination(wrongResource.exchange, resource,
    new AbortController().signal, async () => assert.fail('substituted resource escaped')), /mismatch/u)
  const wrongWriter = fixture(message => message.op === 'executionDestinationHoldFile'
    ? { receipt: { version: 1, runtimeGeneration: `destination-sha256:${'e'.repeat(64)}`,
      reference: message.reference, databaseIdentity: 'component' } } : undefined)
  await assert.rejects(withNativeExecutionDestination(wrongWriter.exchange, resource,
    new AbortController().signal, async scope => { scope.holdFile('journal') }), /file_mismatch/u)
  assert.equal(wrongWriter.calls.at(-1).op, 'executionDestinationClose')
})

test('source cancellation joins the callback before close and retains uncertain cleanup failure', async () => {
  const caller = new AbortController()
  let drained = false
  const { calls, exchange } = fixture(message => {
    if (message.op === 'executionDestinationClose') {
      assert.equal(drained, true)
      throw new Error('uncertain native close')
    }
  })
  await assert.rejects(withNativeExecutionDestination(exchange, resource, caller.signal, async scope => {
    caller.abort(new Error('source withdrawn'))
    assert.throws(scope.recheck, /source withdrawn/u)
    await new Promise(resolve => setTimeout(resolve, 20))
    drained = true
  }), error => error instanceof AggregateError && error.errors.length === 2)
  assert.equal(calls.filter(call => call.op === 'executionDestinationClose').length, 1)
})
