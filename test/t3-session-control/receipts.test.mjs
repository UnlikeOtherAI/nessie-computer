import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { Sqlite, createSessionStateLayers, CommandReceipts, SourceContracts as S } from '@nessie/t3-session-source/engine'
import { observeSessionCommand } from '../../dist/t3-session/control/receipts.js'

const input = { commandId: S.CommandId.make('receipt:original/雪'),
  threadId: S.ThreadId.make('mcp:thread/雪'), commandType: 'queue.resume' }
const acceptedAt = DateTime.makeUnsafe('2026-11-08T00:00:00.000Z')

test('actual original SQLite receipts survive reopen and never imply provider completion', async () => {
  const directory = resolve('.artifacts/t12-control-receipts', randomUUID())
  mkdirSync(directory, { recursive: true })
  const path = resolve(directory, 'synthetic.sqlite')
  const run = program => {
    const host = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
    const state = createSessionStateLayers()
    const layer = state.layer.pipe(Layer.provideMerge(Sqlite.layerFromPath(path).pipe(Layer.provide(host))))
    return Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))))
  }
  const original = { ...input, acceptedAt, resultSequence: 5, status: 'accepted', error: null }
  await run(Effect.gen(function* () {
    assert.deepEqual(yield* observeSessionCommand(input), { state: 'uncertain', reason: 'receipt_not_observed' })
    const store = yield* CommandReceipts.CommandReceiptStoreV2
    assert.equal(yield* store.insertIfAbsent(original), true)
    assert.equal(yield* store.insertIfAbsent({ ...original, resultSequence: 999 }), false)
    const result = yield* observeSessionCommand(input)
    assert.equal(result.state, 'accepted')
    assert.equal(result.receipt.resultSequence, 5)
    assert.equal('completed' in result, false)
  }))
  const recovered = await run(observeSessionCommand(input))
  assert.equal(recovered.state, 'accepted')
  assert.equal(recovered.receipt.commandId, input.commandId)
  assert.equal(recovered.receipt.threadId, input.threadId)
  assert.equal(recovered.receipt.resultSequence, 5)
  await assert.rejects(run(observeSessionCommand({ ...input, threadId: S.ThreadId.make('another:thread') })),
    /T3_CONTROL_RECEIPT_SCOPE_MISMATCH/u)
  await assert.rejects(run(observeSessionCommand({ ...input, commandType: 'message.dispatch' })),
    /T3_CONTROL_RECEIPT_SCOPE_MISMATCH/u)
})

test('unreadable receipt is uncertain and does not become a negative admission result', async () => {
  const observed = await Effect.runPromise(observeSessionCommand(input).pipe(Effect.provide(
    Layer.mock(CommandReceipts.CommandReceiptStoreV2)({ getByCommandId: () => Effect.fail(
      new CommandReceipts.CommandReceiptStoreReadError({ commandId: input.commandId }),
    ) }),
  )))
  assert.deepEqual(observed, { state: 'uncertain', reason: 'receipt_unavailable' })
})
