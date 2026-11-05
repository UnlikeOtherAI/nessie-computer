import assert from 'node:assert/strict'
import test from 'node:test'

import { LocalInferenceApiError } from '../src/local-inference-api.js'
import { startExecutorLocalInferenceSupervisor } from '../src/local-inference-supervisor.js'

const session = (
  heartbeat: () => Promise<void>,
  refused = new Promise<void>(() => undefined),
  connected = Promise.resolve(),
) => {
  let stops = 0
  return { session: { connected, heartbeat, refused, stop: async () => { stops += 1 } }, stops: () => stops }
}

test('local inference registration failure leaves the executor live and reconnects later', async () => {
  const state = { executorId: 'executor-1' } as never
  let enabled = false
  let heartbeats = 0
  const live = session(async () => { heartbeats += 1 })
  const connect = async () => {
    if (!enabled) throw new Error('LOCAL_HOST_UNAVAILABLE')
    return { session: live.session, state }
  }
  const local = await startExecutorLocalInferenceSupervisor('state-dir', state, connect as never)
  assert.equal(local.state, state)
  assert.equal(heartbeats, 0)
  enabled = true
  await local.supervisor.heartbeat()
  assert.equal(heartbeats, 1)
})

test('a dropped socket keeps the host; a refusal claims afresh at the next heartbeat', async () => {
  const state = { executorId: 'executor-1' } as never
  let connects = 0
  let failure: Error = new LocalInferenceApiError('LOCAL_INFERENCE_API_UNREACHABLE')
  const first = session(async () => { throw failure })
  const second = session(async () => undefined)
  const connect = async () => {
    connects += 1
    return { session: connects === 1 ? first.session : second.session, state }
  }
  const local = await startExecutorLocalInferenceSupervisor('state-dir', state, connect as never)
  await local.supervisor.heartbeat()
  assert.equal(first.stops(), 0, 'An unreachable socket reconnects by itself; generations continue.')
  failure = new LocalInferenceApiError('LOCAL_HOST_UNAVAILABLE', 404)
  await local.supervisor.heartbeat()
  assert.equal(first.stops(), 1)
  await local.supervisor.heartbeat()
  assert.equal(connects, 2)
})

test('local reconnect failure retains the latest core executor state', async () => {
  const initial = { executorId: 'first' } as never
  const latest = { executorId: 'latest' } as never
  const local = await startExecutorLocalInferenceSupervisor('state-dir', initial, async () => {
    throw new Error('LOCAL_HOST_UNAVAILABLE')
  })
  assert.equal(await local.supervisor.reconnect(latest), latest)
})

test('a claim refused for rate waits five minutes before the next claim, then recovers', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const state = { executorId: 'executor-1' } as never
  let connects = 0
  let limited = true
  const live = session(async () => undefined)
  const connect = async () => {
    connects += 1
    if (limited) throw new LocalInferenceApiError('RATE_LIMITED', 429)
    return { session: live.session, state }
  }
  const local = await startExecutorLocalInferenceSupervisor('state-dir', state, connect as never)
  assert.equal(connects, 1)
  limited = false
  t.mock.timers.tick(20_000)
  await local.supervisor.heartbeat()
  assert.equal(connects, 1, 'twenty seconds after a 429, the heartbeat does not spend two more challenges')
  t.mock.timers.tick(4 * 60_000)
  await local.supervisor.heartbeat()
  assert.equal(connects, 1, 'still inside the five-minute wait')
  t.mock.timers.tick(60_000)
  await local.supervisor.heartbeat()
  assert.equal(connects, 2, 'after the wait the host is claimed again')
})

test('a heartbeat right after a fresh claim waits for the socket to open and never closes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = { executorId: 'executor-1' } as never
  let connects = 0
  let heartbeats = 0
  let markConnected: () => void = () => undefined
  const opening = new Promise<void>((resolve) => { markConnected = resolve })
  const live = session(async () => { heartbeats += 1 }, undefined, opening)
  const connect = async () => {
    connects += 1
    if (connects === 1) throw new Error('LOCAL_HOST_UNAVAILABLE')
    return { session: live.session, state }
  }
  const local = await startExecutorLocalInferenceSupervisor('state-dir', state, connect as never)
  // Reconnected inside the heartbeat: the socket is still opening.
  const first = local.supervisor.heartbeat()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(connects, 2)
  t.mock.timers.tick(15_000)
  await first
  assert.equal(heartbeats, 0, 'no heartbeat was sent into a socket that had not opened')
  assert.equal(live.stops(), 0, 'the socket was left to open on its own, not closed')
  markConnected()
  await local.supervisor.heartbeat()
  assert.equal(heartbeats, 1, 'the next heartbeat found the socket open and used it')
  assert.equal(connects, 2, 'nothing claimed afresh')
})

test('a socket that opens within the wait is heartbeated in the same call', async () => {
  const state = { executorId: 'executor-1' } as never
  let connects = 0
  let heartbeats = 0
  const live = session(async () => { heartbeats += 1 })
  const connect = async () => {
    connects += 1
    if (connects === 1) throw new Error('LOCAL_HOST_UNAVAILABLE')
    return { session: live.session, state }
  }
  const local = await startExecutorLocalInferenceSupervisor('state-dir', state, connect as never)
  await local.supervisor.heartbeat()
  assert.equal(connects, 2)
  assert.equal(heartbeats, 1)
  assert.equal(live.stops(), 0)
})
