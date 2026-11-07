import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { canonicalExecutorPayload, EXECUTOR_MONITOR_VIEW_TTL_MS,
  type ExecutorMonitorSnapshot } from '@nessie/executor-protocol'
import { startComputerMonitor } from '../src/computer-monitor.js'
import { appendMonitorHistory } from '../src/system-monitor.js'
import { createDaemonCadence, type CadenceTask } from '../src/daemon-cadence.js'
import { heartbeatExecutor } from '../src/daemon-connection.js'
import type { ExecutorLocalState } from '../src/state-store.js'

const sampleAt = (at: number): Omit<ExecutorMonitorSnapshot, 'subscriptions'> => ({
  capturedAt: new Date(at).toISOString(), os: 'windows', processor: 'Measured CPU', cpu: 23, gpu: 10,
  history: [], memoryUsedBytes: 100, memoryTotalBytes: 1000, diskUsedBytes: 1000, diskTotalBytes: 2000,
  uptimeSeconds: 500, processes: [],
})

test('the local history retains only the measured last minute and discards gaps after sleep', () => {
  let history: ExecutorMonitorSnapshot['history'] = []
  for (let at = 0; at <= 90_000; at += 3_000) {
    history = appendMonitorHistory(history, { at: new Date(at).toISOString(), cpu: at / 1000, gpu: null })
  }
  assert.equal(history.length, 20)
  assert.equal(history[0]?.at, new Date(33_000).toISOString())
  assert.equal(history.at(-1)?.cpu, 90)
  const resumed = appendMonitorHistory(history, { at: new Date(160_000).toISOString(), cpu: null, gpu: null })
  assert.deepEqual(resumed, [{ at: new Date(160_000).toISOString(), cpu: null, gpu: null }])
  assert.equal(history.length, 20, 'previous snapshots remain immutable')
})

test('idle local sampling sends nothing; first demand returns cached history, expires and survives reconnection', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let now = 1_800_000_000_000
  let history: ExecutorMonitorSnapshot['history'] = []
  let probes = 0
  let samples = 0
  const monitor = startComputerMonitor('unused', {
    now: () => now, enabled: async () => true,
    ci: async () => ({ status: 'ready', checkedAt: new Date(now).toISOString(), truncated: false, pullRequests: [] }),
    sample: async () => {
      samples += 1
      const current = sampleAt(now)
      history = appendMonitorHistory(history, { at: current.capturedAt, cpu: 23, gpu: 10 })
      return { ...current, history }
    },
    probe: async () => { probes += 1; return { accounts: [], incomplete: false } },
  })
  const advance = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await setImmediate() }
  try {
    await setImmediate()
    monitor.connected(true)
    for (let tick = 0; tick < 21; tick += 1) await advance(3_000)
    assert.equal(monitor.current(), undefined)
    assert.equal(probes, 0, 'no provider subprocess is needed without a viewer')
    const sampled = samples
    assert.equal(monitor.request({ expiresAt: new Date(now + EXECUTOR_MONITOR_VIEW_TTL_MS).toISOString() }), true)
    const first = monitor.current()!
    assert.equal(first.history.length, 20, 'first upload already contains the previous minute')
    assert.equal(samples, sampled, 'opening the view does not restart or oversample the history')
    await setImmediate()
    assert.equal(probes, 1)
    assert.equal(monitor.request({ expiresAt: new Date(now + EXECUTOR_MONITOR_VIEW_TTL_MS).toISOString() }), false,
      'renewing another viewer does not open a second stream')
    await advance(15_000)
    assert.equal(monitor.current(), undefined, 'an abandoned viewer cannot keep reporting')
    assert.ok(samples > sampled, 'local history continues while reporting is idle')
    monitor.request({ expiresAt: new Date(now + 1_000_000).toISOString() })
    await advance(15_000)
    assert.equal(monitor.watching(), false, 'even an oversized server deadline is locally bounded')
    monitor.request({ expiresAt: new Date(now + 10_000).toISOString() })
    monitor.connected(false)
    monitor.connected(true)
    assert.equal(monitor.current(), undefined, 'a reconnected epoch must receive a new viewing request')
    assert.equal(monitor.request({ expiresAt: new Date(now + 10_000).toISOString() }), true)
    assert.ok(monitor.current()?.history.length)
    monitor.request(null)
    assert.equal(monitor.current(), undefined, 'old or refusing servers cannot leave a previous stream active')
  } finally { await monitor.stop() }
})

test('an expired request cannot start a provider probe after the local setting resolves', async () => {
  let now = Date.now()
  let allow!: (enabled: boolean) => void
  let probes = 0
  const setting = new Promise<boolean>(resolve => { allow = resolve })
  const monitor = startComputerMonitor('unused', {
    now: () => now, sample: async () => sampleAt(now), enabled: () => setting,
    ci: async () => ({ status: 'ready', checkedAt: new Date(now).toISOString(), truncated: false, pullRequests: [] }),
    probe: async () => { probes += 1; return { accounts: [], incomplete: false } },
  })
  try {
    monitor.connected(true)
    monitor.request({ expiresAt: new Date(now + EXECUTOR_MONITOR_VIEW_TTL_MS).toISOString() })
    now += EXECUTOR_MONITOR_VIEW_TTL_MS
    allow(true)
    await setImmediate()
    assert.equal(probes, 0)
  } finally { await monitor.stop() }
})

test('heartbeat negotiates demand under its signature and does not let malformed offers fail liveness', async () => {
  const keys = generateKeyPairSync('ed25519')
  const state = { executorId: randomUUID(), apiBaseUrl: 'http://fixture.test', connectionEpoch: '1',
    machinePrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  } as ExecutorLocalState
  const expiresAt = new Date(Date.now() + 15_000).toISOString()
  let offer: unknown = { expiresAt }
  let received: unknown
  const api = { heartbeat: async (_url: string, input: Record<string, unknown>) => {
    const { signature, ...payload } = input
    const valid = (value: Record<string, unknown>) => verify(null,
      Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.heartbeat.v1', value)), keys.publicKey,
      Buffer.from(signature as string, 'base64url'))
    assert.equal(valid(payload), true)
    const { monitorVersion, ...unnegotiated } = payload
    assert.equal(monitorVersion, 1)
    assert.equal(valid(unnegotiated), false, 'negotiation cannot be stripped')
    return { connectionEpoch: '1', status: 'online', monitorRequest: offer }
  } }
  const receive = (value: unknown) => { received = value }
  await heartbeatExecutor(state, undefined, undefined, undefined, api, undefined, undefined, receive)
  assert.deepEqual(received, { expiresAt })
  offer = { expiresAt: 'invalid' }
  await heartbeatExecutor(state, undefined, undefined, undefined, api, undefined, undefined, receive)
  assert.equal(received, null)
})

test('one cadence owns quiet heartbeats and switches to five-second uploads only while viewed', async () => {
  let now = 0
  let hot = false
  let heartbeats = 0
  const noop: CadenceTask = { current: () => null, run: async () => undefined }
  const heartbeat: CadenceTask = { current: () => null, run: async () => { heartbeats += 1 } }
  const cadence = createDaemonCadence({ commands: noop, sessions: noop, heartbeat,
    sessionsHot: () => false, monitorHot: () => hot, now: () => now })
  cadence.tick()
  assert.equal(heartbeats, 1)
  now = 19_999; cadence.tick()
  assert.equal(heartbeats, 1)
  now = 20_000; cadence.tick()
  assert.equal(heartbeats, 2)
  hot = true
  now = 24_999; cadence.tick()
  assert.equal(heartbeats, 2)
  now = 25_000; cadence.tick()
  assert.equal(heartbeats, 3)
  hot = false
  now = 40_000; cadence.tick()
  assert.equal(heartbeats, 3)
  now = 45_000; cadence.tick()
  assert.equal(heartbeats, 4)
})
