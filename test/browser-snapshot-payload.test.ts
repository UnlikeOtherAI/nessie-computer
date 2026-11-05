import assert from 'node:assert/strict'
import test from 'node:test'

import { parseBrowserObservation } from '../src/guest-vm-payloads.js'

const payload = (observation: Record<string, unknown>) => Buffer.from(JSON.stringify({ version: 1, observation }))
test('guest snapshot guarantee and private projection metadata survive strict decoding', () => {
  const observation = { snapshotVersion: 1, targets: [], accessibilityTree: [
    { nodeId: 1, role: 'textbox', name: 'Label', value: 'legacy value' },
    { nodeId: 2, role: 'StaticText', name: 'legacy value', snapshotExcluded: true },
    { nodeId: 3, role: 'button', name: 'unsafe derived value', snapshotName: '' },
  ] }
  assert.deepEqual(parseBrowserObservation(payload(observation)), observation)
  assert.equal(parseBrowserObservation(payload({ targets: [], accessibilityTree: [] })).snapshotVersion, undefined)
  assert.throws(() => parseBrowserObservation(payload({ ...observation, snapshotVersion: 2 })))
  for (const field of [{ snapshotName: 7 }, { snapshotName: 'x'.repeat(257) }, { snapshotExcluded: 'true' }]) {
    assert.throws(() => parseBrowserObservation(payload({ ...observation, accessibilityTree: [
      { nodeId: 1, role: 'textbox', name: 'Label', ...field },
    ] })))
  }
})
