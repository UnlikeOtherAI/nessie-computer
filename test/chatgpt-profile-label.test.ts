import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalInferenceHostLoop } from '../src/local-inference-host.js'
import { HOST_ID, ORG_ID, coordinatorFixture, machineKeys, attempt, ollama, receiptJournal, apiFor }
  from './fixtures/local-inference-host.js'

test('inventory reports follow a named connection without changing its models or making inference calls', async t => {
  const keys = machineKeys(), { journal } = receiptJournal(), { api, calls } = apiFor(attempt())
  let label = 'ChatGPT OR Main'
  const loop = new LocalInferenceHostLoop({ transport: api, coordinator: await coordinatorFixture(t),
    fetchImpl: ollama([]), connectionLabel: async () => label,
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false, now: () => new Date('2026-11-11T01:00:00.000Z'), journal, origin: 'http://127.0.0.1:11434' })
  await loop.heartbeat()
  label = 'ChatGPT OR Work'
  await loop.heartbeat()
  assert.deepEqual(calls.heartbeats.map(call => call.heartbeat.displayLabel), ['ChatGPT OR Main', 'ChatGPT OR Work'])
  assert.deepEqual(calls.heartbeats[0]?.heartbeat.inventory, calls.heartbeats[1]?.heartbeat.inventory)
  assert.equal(calls.accepts.length, 0)
  assert.equal(calls.results.length, 0)
})
