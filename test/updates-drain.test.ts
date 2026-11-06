import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalInferenceHostLoop } from '../src/local-inference-host.js'
import { waitForExecutorDaemonShutdown } from '../src/daemon.js'
import { HOST_ID, ORG_ID, coordinatorFixture, machineKeys, attempt, ollama, receiptJournal, apiFor,
} from './fixtures/local-inference-host.js'

test('an update pauses new inference claims without aborting an active generation, and opt-out resumes claims', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api, calls } = apiFor(attempt())
  let claims = 0
  const transport = { ...api, claim: async (...args: Parameters<typeof api.claim>) => {
    claims += 1
    return api.claim(...args)
  } }
  let entered: () => void = () => undefined
  let release: () => void = () => undefined
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fetch = ollama([{ done: true, done_reason: 'stop', eval_count: 1,
    message: { content: 'finished normally' }, model: 'local:latest', prompt_eval_count: 1 }])
  const loop = new LocalInferenceHostLoop({ transport, coordinator: await coordinatorFixture(t),
    fetchImpl: async (...args) => {
      if (String(args[0]).endsWith('/api/chat')) { entered(); await gate }
      return fetch(...args)
    }, identity: { connectionEpoch: '1', hostId: HOST_ID,
      machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false, journal, origin: 'http://127.0.0.1:11434' })
  const running = loop.pollOnce()
  await started
  assert.equal(loop.isIdle(), false)
  await loop.drain()
  assert.equal(loop.isIdle(), false, 'the in-flight generation still owns its native resources')
  release()
  await running
  assert.equal(calls.results[0]?.receipt.result.content, 'finished normally')
  assert.equal(loop.isIdle(), true)
  assert.deepEqual(await loop.pollOnce(), { kind: 'idle' })
  assert.equal(claims, 1)
  loop.resume()
  await loop.pollOnce()
  assert.equal(claims, 2, 'disabling the pending automatic update restores ordinary claims')
})

test('a completed update drain uses the supported daemon shutdown interface and releases its signal listeners', async () => {
  const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]
  let ready: () => void = () => undefined
  const update = new Promise<void>((resolve) => { ready = resolve })
  const stopped = waitForExecutorDaemonShutdown(undefined, update)
  ready()
  await stopped
  assert.deepEqual([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')], before)
})
