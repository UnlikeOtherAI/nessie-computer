import assert from 'node:assert/strict'
import { test } from 'node:test'
import { load } from './load-source.mjs'

const { bindNativeHistoryHomes } = await load('t3-session/native-sources/history-homes')
const { describeAliasCandidates } = await load('t3-session/ownership/continuity')
const source = { admittedRootKey: 'admitted', physicalRootKey: 'physical', environmentId: 'environment',
  layout: 'v2-80', databaseRole: 'authoritative-v2' }
const target = { source, providerThread: { id: 'provider:1', appThreadId: 'app:1', driver: 'claude-code',
  nativeThreadRef: { driver: 'claude-code', nativeId: 'native:1', strength: 'strong' } } }
const lease = { admittedRootKey: source.admittedRootKey, physicalRootKey: source.physicalRootKey,
  environmentId: source.environmentId, providerThreadId: 'provider:1', appThreadId: 'app:1',
  driver: 'claude-code', nativeId: 'native:1', continuationHomeKey: 'continuation', historyHomeKey: 'overlay:1',
  homeProofReference: 'fixture:proof', recheck: async () => {} }

test('unbound homes cannot be fabricated from original native reference or labels', async () => {
  assert.equal(await bindNativeHistoryHomes().proveHomes(target), undefined)
})

test('exact home affinity is checked across every source and application identity', async () => {
  const resource = value => ({ withHomes: async (_target, use) => use(value) })
  assert.deepEqual(await bindNativeHistoryHomes(resource(lease)).proveHomes(target), {
    continuationHomeKey: 'continuation', historyHomeKey: 'overlay:1', homeProofReference: 'fixture:proof',
  })
  for (const key of ['admittedRootKey', 'physicalRootKey', 'environmentId', 'providerThreadId', 'appThreadId', 'driver', 'nativeId']) {
    await assert.rejects(bindNativeHistoryHomes(resource({ ...lease, [key]: 'another' })).proveHomes(target), /affinity_mismatch/u)
  }
})

test('shared continuation never collapses app identities or separate overlays into a writer', async () => {
  const first = { threadId: 'app:1', providerThreadId: 'provider:1', driver: lease.driver, nativeId: lease.nativeId,
    strength: 'strong', continuationHomeKey: lease.continuationHomeKey, historyHomeKey: lease.historyHomeKey,
    homeProofReference: lease.homeProofReference }
  const candidates = [first, { ...first, threadId: 'app:2', historyHomeKey: 'overlay:2' }]
  const result = describeAliasCandidates(candidates)
  assert.equal(result.state, 'ambiguous')
  assert.deepEqual(result.candidates, candidates)
  assert.equal(result.control, 'unavailable')
})

test('revocation before returning home proof rejects the result', async () => {
  let checks = 0
  const port = bindNativeHistoryHomes({ withHomes: async (_target, use) => use({ ...lease,
    recheck: async () => { if (++checks === 2) throw new Error('revoked') } }) })
  await assert.rejects(port.proveHomes(target), /revoked/u)
})
