import assert from 'node:assert/strict'
import test from 'node:test'

import { LocalInferenceApiError } from '../src/local-inference-api.js'
import { superviseDirectLocalInference } from '../src/direct-local-inference-runtime.js'

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds)
})

const waitUntil = async (satisfied: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!satisfied() && Date.now() < deadline) await pause(1)
}

const never = new Promise<void>(() => undefined)

test('direct Desktop supervision keeps fresh inventory heartbeats non-overlapping', async () => {
  let release: (() => void) | null = null
  const stopped = new Promise<void>((resolve) => { release = resolve })
  let heartbeats = 0
  let concurrentHeartbeats = 0
  let maxConcurrentHeartbeats = 0
  const session = {
    heartbeat: async () => {
      heartbeats += 1
      concurrentHeartbeats += 1
      maxConcurrentHeartbeats = Math.max(maxConcurrentHeartbeats, concurrentHeartbeats)
      await pause(12)
      concurrentHeartbeats -= 1
    },
    refused: never,
    stop: async () => undefined,
  }
  const supervised = superviseDirectLocalInference({ heartbeatIntervalMs: 4, session, stopped })
  // Wait for the condition the test is about, with a deadline generous
  // enough that only a real stall trips it.
  await waitUntil(() => heartbeats >= 2)
  release?.()
  await supervised
  assert.ok(heartbeats >= 2)
  assert.equal(maxConcurrentHeartbeats, 1)
})

test('direct Desktop supervision ends the host when Nessie refuses it, not when the socket drops', async () => {
  let failure: Error = new LocalInferenceApiError('LOCAL_INFERENCE_API_UNREACHABLE')
  let heartbeats = 0
  let stops = 0
  const session = {
    heartbeat: async () => { heartbeats += 1; throw failure },
    refused: never,
    stop: async () => { stops += 1 },
  }
  const supervised = superviseDirectLocalInference({ heartbeatIntervalMs: 1, session, stopped: never })
  await waitUntil(() => heartbeats >= 3)
  assert.equal(stops, 0, 'A dropped socket reconnects on its own.')
  failure = new LocalInferenceApiError('LOCAL_HOST_UNAVAILABLE', 404)
  await assert.rejects(supervised, /LOCAL_HOST_UNAVAILABLE/)
  assert.equal(stops, 1)
})
