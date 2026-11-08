import assert from 'node:assert/strict'
import test from 'node:test'
import type { T3LaneInspection } from '@nessie/executor-protocol/t3-session'
import { createT3InspectionPump } from '../src/t3-session-inspections.js'

test('retained runtime cannot inspect or accidentally execute an inspection offer', async () => {
  let opened = false
  const pump = createT3InspectionPump({ describe: async () => [],
    async *open() { opened = true; throw new Error('Inspection must not execute') } })
  assert.throws(() => pump.accept('executor', '1', [], [{} as T3LaneInspection], [], [], 64),
    /T3_EXECUTION_INSPECTION_UNBOUND/u)
  assert.equal(opened, false)
  assert.equal(pump.size(), 0)
  await pump.close()
})

test('inspection acknowledgements cannot discard an unknown or unsent receipt', async () => {
  const pump = createT3InspectionPump({ describe: async () => [], async *open() {} })
  assert.throws(() => pump.accept('executor', '1', [], [], ['a'.repeat(64)], [], 64),
    /T3_INVALID_INSPECTION_ACK/u)
  assert.deepEqual(pump.frames(), [])
  await pump.close()
})
