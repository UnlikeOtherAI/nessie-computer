import assert from 'node:assert/strict'
import test from 'node:test'

import type { LocalInferenceAttemptLease } from '../src/local-inference-api.js'
import { LocalInferenceHostLoop } from '../src/local-inference-host.js'
import { ADMISSION, ATTEMPT_ID, HOST_ID, ORG_ID, apiFor, attempt, coordinatorFixture,
  machineKeys, receiptJournal } from './fixtures/local-inference-host.js'

test('a settlement-only replay never reads a request and releases capacity only after acknowledgement', async t => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api, calls } = apiFor(attempt())
  const coordinator = await coordinatorFixture(t)
  const replay: LocalInferenceAttemptLease = {
    admission: ADMISSION, attempt: { attemptId: ATTEMPT_ID }, dispatchFence: null,
  }
  // Any accidental attempt to inspect prompt, model or deadline fails here.
  replay.attempt = new Proxy(replay.attempt, { get: (target, key) => {
    assert.equal(key, 'attemptId', 'Settlement must not read undisclosed request fields')
    return target.attemptId
  } })
  const requestIds: string[] = []
  api.claim = async poll => {
    requestIds.push(poll.requestId)
    if (requestIds.length === 1) throw new Error('lost claim response')
    return replay
  }
  const terminations: unknown[] = []
  let acknowledge = false
  api.terminate = async termination => {
    terminations.push(termination)
    if (!acknowledge) throw new Error('lost termination response')
    return { acknowledged: true }
  }
  const loop = new LocalInferenceHostLoop({ transport: api, coordinator, journal,
    fetchImpl: async () => assert.fail('Settlement must not invoke or discover a model'),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false, origin: 'http://127.0.0.1:11434',
  })
  await assert.rejects(loop.pollOnce(), /lost claim response/u)
  assert.equal(await coordinator.acquire('other-host'), null)
  await assert.rejects(loop.pollOnce(), /lost termination response/u)
  assert.equal(requestIds[0], requestIds[1], 'Replay settles the original poll token')
  assert.deepEqual(terminations, [{ ...ADMISSION, attemptId: ATTEMPT_ID, confirmed: true }])
  assert.equal(await coordinator.acquire('other-host'), null, 'Unacknowledged physical capacity stays reserved')
  acknowledge = true
  api.claim = async () => assert.fail('The waiting other host owns the next polling turn')
  assert.deepEqual(await loop.pollOnce(), { kind: 'busy' })
  assert.deepEqual(terminations[1], terminations[0])
  assert.deepEqual(calls.accepts, [])
  assert.deepEqual(calls.frames, [])
  assert.deepEqual(calls.results, [])
  const available = await coordinator.acquire('other-host')
  assert.ok(available)
  await available.releaseIdle()
})

test('an acknowledged settlement-only answer returns fenced with no model invocation', async t => {
  const { api, calls } = apiFor(null)
  const coordinator = await coordinatorFixture(t)
  const terminations: unknown[] = []
  api.claim = async () => ({ admission: ADMISSION, attempt: { attemptId: ATTEMPT_ID }, dispatchFence: null })
  api.terminate = async termination => { terminations.push(termination); return { acknowledged: true } }
  const loop = new LocalInferenceHostLoop({ transport: api, coordinator, journal: receiptJournal().journal,
    fetchImpl: async () => assert.fail('Settlement cannot invoke a model'),
    identity: { connectionEpoch: '1', hostId: HOST_ID,
      machinePrivateKey: machineKeys().privateKey, organizationId: ORG_ID },
    isPaused: () => false, origin: 'http://127.0.0.1:11434',
  })
  assert.deepEqual(await loop.pollOnce(), { attemptId: ATTEMPT_ID, kind: 'fenced' })
  assert.deepEqual(terminations, [{ ...ADMISSION, attemptId: ATTEMPT_ID, confirmed: true }])
  assert.equal(calls.accepts.length + calls.frames.length + calls.results.length, 0)
  const slot = await coordinator.acquire('other-host')
  assert.ok(slot)
  await slot.releaseIdle()
})
