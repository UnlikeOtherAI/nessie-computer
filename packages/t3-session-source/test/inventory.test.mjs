import assert from 'node:assert/strict'
import test from 'node:test'
import { extractT3CommandInventory } from '../inventory.mjs'

const snapshot = text => ({ read: () => Buffer.from(text) })
const declaration = body => `const OrchestrationV2InternalCommand = Schema.Union([${body}]);`

test('command inventory reads only root command discriminants without executing source', () => {
  const source = declaration(`
    Schema.Struct({ type: Schema.Literal('first'), nested: Schema.Struct({ type: Schema.Literal('nested') }) }),
    Schema.Struct({ "type": Schema.Literal("second"), sideEffect: doNotExecute() }),
  `)
  const inventory = extractT3CommandInventory(snapshot(source))
  assert.deepEqual(inventory.internalCommands, ['first', 'second'])
  assert.equal(inventory.source, 'packages/contracts/src/orchestrationV2.ts')
  assert.match(inventory.sourceSha256, /^[a-f0-9]{64}$/u)
  assert.notEqual(extractT3CommandInventory(snapshot(source + '\n')).sourceSha256, inventory.sourceSha256)
})

test('unknown command shapes and duplicate discriminants refuse the inventory', () => {
  for (const body of ['', 'unknownSchema',
    'Schema.Struct({ type: Schema.String })',
    'Schema.Struct({ type: Schema.Literal("one", "two") })',
    'Schema.Struct({ type: Schema.Literal("same") }), Schema.Struct({ type: Schema.Literal("same") })',
    'Schema.Struct({ type: Schema.Literal("one"), type: Schema.Literal("two") })']) {
    assert.throws(() => extractT3CommandInventory(snapshot(declaration(body))), /T3_COMMAND_INVENTORY_SOURCE_CHANGED/u)
  }
  assert.throws(() => extractT3CommandInventory(snapshot('const renamed = Schema.Union([]);')),
    /T3_COMMAND_INVENTORY_SOURCE_CHANGED/u)
})
