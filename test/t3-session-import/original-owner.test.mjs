import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareTinySources } from './tiny-source.mjs'

const tiny = await prepareTinySources()
const { unprovenRetainedOriginalOwnerPort } = await tiny.load('ownership/original-owner')
const source = { admittedRootKey: 'admitted:one', physicalRootKey: 'physical:one', environmentId: 'env:雪',
  layout: 'v2-80', databaseRole: 'authoritative-v2' }

test('production refusal never invokes an asserted physical proof or permits source content access', async () => {
  let physicalCalls = 0
  let reads = 0
  const input = { source, captureGeneration: 'capture:one', purpose: 'retained-history-read',
    physicalSourceRecheck: async () => { physicalCalls++ } }
  await assert.rejects(unprovenRetainedOriginalOwnerPort.withReadScope(input, async () => { reads++ }),
    { code: 'retained_original_owner_unproven' })
  assert.equal(physicalCalls, 0)
  assert.equal(reads, 0)
})

test('serialized owner claims, current login, generation changes and retries cannot mint historical proof', async () => {
  for (const extra of [{}, { actorUserId: 'current-person', originalOwnerGeneration: 'asserted' },
    { role: 'owner', admissionReference: 'serialized', expiresAt: Date.now() + 60_000 }]) {
    for (const generation of ['capture:one', 'capture:two']) {
      await assert.rejects(unprovenRetainedOriginalOwnerPort.withReadScope({
        source, captureGeneration: generation, purpose: 'retained-history-read', ...extra,
        physicalSourceRecheck: async () => { throw new Error('must not call arbitrary supplied code') },
      }, async () => { throw new Error('must not read source') }), { code: 'retained_original_owner_unproven' })
    }
  }
  assert.equal(Object.isFrozen(unprovenRetainedOriginalOwnerPort), true)
})
