import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalInferenceHostLoop } from '../src/local-inference-host.js'
import { waitForExecutorDaemonShutdown } from '../src/daemon.js'
import { watchInferenceUpdateDrain } from '../src/updates/inference-drain.js'
import type { ExecutorSoftwareStatus } from '@nessie/executor-protocol'
import { setTimeout as delay } from 'node:timers/promises'
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

test('direct and personal hosts retain an update pause through outages, resume on opt-out, and exit only when idle', async (t) => {
  let status: ExecutorSoftwareStatus = { format: 1, installedVersion: '1.0.0', targetVersion: '1.0.1',
    automatic: true, channel: 'stable', canInstall: true, draining: true, phase: 'waiting' }
  let idle = false
  let paused = false
  let unavailable = false
  let reads = 0
  const watcher = watchInferenceUpdateDrain({ installedVersion: '1.0.0', intervalMs: 5,
    loop: { drain: async () => { paused = true }, resume: () => { paused = false }, isIdle: () => idle },
    readStatus: async () => { reads++; if (unavailable) throw new Error('offline'); return status } })
  t.after(watcher.stop)
  const until = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 2000
    while (!condition()) { assert.ok(Date.now() < deadline, 'update observation timed out'); await delay(5) }
  }
  let ready = false
  void watcher.ready.then(() => { ready = true })
  await until(() => paused)
  assert.equal(ready, false, 'active work is never aborted to reach an installer')
  unavailable = true
  const priorReads = reads
  await until(() => reads > priorReads + 1)
  assert.equal(paused, true, 'an uncertain coordinator cannot reopen new claims')
  unavailable = false
  status = { ...status, automatic: false, draining: false, phase: 'available' }
  await until(() => !paused)
  assert.equal(ready, false)
  status = { ...status, draining: true, phase: 'waiting' }
  await until(() => paused)
  idle = true
  assert.equal(await watcher.ready, '1.0.1')
})

test('a newly installed host does not drain itself while its fresh health is being confirmed', async (t) => {
  let resumed = false
  const watcher = watchInferenceUpdateDrain({ installedVersion: '1.0.1', intervalMs: 5,
    loop: { drain: async () => { assert.fail('the target generation must remain running') },
      resume: () => { resumed = true }, isIdle: () => true },
    readStatus: async () => ({ format: 1, installedVersion: '1.0.1', targetVersion: '1.0.1', automatic: true,
      canInstall: true, draining: true, phase: 'restarting', channel: 'stable' }) })
  t.after(watcher.stop)
  await delay(20)
  assert.equal(resumed, true)
})
