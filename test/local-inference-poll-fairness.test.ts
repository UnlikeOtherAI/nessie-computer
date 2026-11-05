import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import { LocalInferenceCoordinator } from '../src/local-inference-coordinator.js'
import { LocalInferenceHostLoop } from '../src/local-inference-host.js'
import { assertStateSecurityHelperResponse } from '../src/state-security.js'
import { ADMISSION, apiFor, machineKeys, receiptJournal, RESOURCE_ID, ORG_ID } from './fixtures/local-inference-host.js'
import { nativeInferenceSecurityHelper, verifyInferenceTestState } from './fixtures/local-inference-security.js'

const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

const execute = promisify(execFile)

const fixture = async (t: test.TestContext, options: { now?: () => number; capacity?: number } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-poll-fairness-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const security = { platform: 'win32' as const, helper: verifyInferenceTestState }
  const fixtureTime = Date.now()
  const now = options.now ?? (() => fixtureTime)
  const first = await LocalInferenceCoordinator.open({ directory, security, now })
  const second = await LocalInferenceCoordinator.open({ directory, security, now })
  await first.syncControl({
    resourceId: RESOURCE_ID, capacity: options.capacity ?? 1, controlRevision: 1, paused: false, healthReason: null,
  })
  t.diagnostic(nativeInferenceSecurityHelper ? 'Real Windows native security helper.' : 'Portable Windows wire verdict.')
  return { first, second, directory, security }
}

const host = (coordinator: LocalInferenceCoordinator) => {
  const { api } = apiFor(null)
  const identity = machineKeys()
  let polls = 0
  let boundary: (() => Promise<void>) | undefined
  api.claim = async () => {
    polls += 1
    await boundary?.()
    return { attempt: null, dispatchFence: null, admission: null }
  }
  const loop = new LocalInferenceHostLoop({
    transport: api, coordinator, journal: receiptJournal().journal, isPaused: () => false,
    origin: 'http://127.0.0.1:11434',
    identity: { machinePrivateKey: identity.privateKey, hostId: randomUUID(), organizationId: ORG_ID, connectionEpoch: '1' },
  })
  return { loop, polls: () => polls, boundary: (next?: () => Promise<void>) => { boundary = next } }
}

test('an idle host cannot repeatedly retake capacity ahead of another host waiting to poll', async (t) => {
  const { first, second } = await fixture(t)
  const idle = host(first)
  const waiting = host(second)
  const reached = gate()
  const release = gate()
  idle.boundary(async () => { reached.release(); await release.promise })
  const idlePoll = idle.loop.pollOnce()
  await reached.promise
  try {
    assert.deepEqual(await waiting.loop.pollOnce(), { kind: 'busy' })
    assert.equal(waiting.polls(), 0, 'The two calls overlap while the idle host holds the real slot.')
  } finally { release.release(); await idlePoll }
  idle.boundary()
  await idle.loop.pollOnce()
  assert.equal(idle.polls(), 1, 'An idle host must yield its next turn to the host that already waited.')
  await waiting.loop.pollOnce()
  assert.equal(waiting.polls(), 1, 'The waiting team reaches the server without changing physical capacity.')
  await idle.loop.pollOnce()
  assert.equal(idle.polls(), 2, 'Both hosts continue after the waiter has taken its turn.')
})

test('an unserved hung host intent expires while its physical reservation never does', async (t) => {
  let now = Date.now()
  const { first, second } = await fixture(t, { now: () => now })
  const active = await first.acquire(randomUUID())
  assert.ok(active)
  assert.equal(await second.acquire(randomUUID()), null)
  now += 60_000
  const nextHost = randomUUID()
  assert.equal(await first.acquire(nextHost), null, 'Time does not reclaim the still-reserved physical slot.')
  await active.releaseIdle()
  const next = await first.acquire(nextHost)
  assert.ok(next, 'The old unserved intent cannot block a live host after expiry.')
  await next.releaseIdle()
})

test('a dead process waiting to poll does not hold the next idle turn', async (t) => {
  const { first, directory } = await fixture(t)
  const hostId = randomUUID()
  const active = await first.acquire(hostId)
  assert.ok(active)
  const child = fileURLToPath(new URL('./fixtures/local-inference-coordinator-child.mjs', import.meta.url))
  const { stdout } = await execute(process.execPath, ['--import', 'tsx', child, directory, randomUUID()])
  assert.equal((JSON.parse(stdout) as { requestId: string | null }).requestId, null)
  await active.releaseIdle()
  assert.ok(await first.acquire(hostId), 'A dead waiter is removed without waiting for the intent TTL.')
})

test('two physical slots serve waiting hosts before their previous idle owners', async (t) => {
  const { first, second } = await fixture(t, { capacity: 2 })
  const [a, b, c, d] = Array.from({ length: 4 }, () => randomUUID())
  assert.ok(a && b && c && d)
  const firstSlot = await first.acquire(a)
  const secondSlot = await second.acquire(b)
  assert.ok(firstSlot && secondSlot)
  assert.equal(await first.acquire(c), null)
  assert.equal(await second.acquire(d), null)
  await firstSlot.releaseIdle()
  assert.equal(await first.acquire(a), null)
  const thirdSlot = await first.acquire(c)
  assert.ok(thirdSlot)
  await secondSlot.releaseIdle()
  assert.equal(await second.acquire(b), null)
  const fourthSlot = await second.acquire(d)
  assert.ok(fourthSlot)
  assert.equal(await first.acquire(randomUUID()), null, 'Fair turns never exceed physical capacity.')
  await thirdSlot.releaseIdle()
  await fourthSlot.releaseIdle()
})

test('duplicate polls from a waiting host retain one FIFO position', async (t) => {
  const { first, second } = await fixture(t)
  const owner = await first.acquire(randomUUID())
  assert.ok(owner)
  const waiter = randomUUID()
  const following = randomUUID()
  assert.equal(await second.acquire(waiter), null)
  assert.equal(await second.acquire(waiter), null)
  assert.equal(await first.acquire(following), null)
  await owner.releaseIdle()
  const next = await second.acquire(waiter)
  assert.ok(next)
  await next.releaseIdle()
  assert.equal(await second.acquire(waiter), null, 'A duplicate request cannot create a second priority ticket.')
  assert.ok(await first.acquire(following))
})

test('never-started poll replay keeps its token and settles before fair new work', async (t) => {
  const { first, second } = await fixture(t)
  const originalHost = randomUUID()
  const waiter = randomUUID()
  const original = await first.acquire(originalHost)
  assert.ok(original)
  assert.equal(await second.acquire(waiter), null)
  await original.abandonPoll()
  const recovered = await second.acquire(originalHost)
  assert.equal(recovered?.requestId, original.requestId)
  assert.equal(await second.acquire(waiter), null)
  await recovered?.releaseIdle()
  assert.equal(await first.acquire(originalHost), null, 'Replay settles the old token without bypassing the waiting turn.')
  assert.ok(await second.acquire(waiter))
})

test('intent expiry never discards an uncertain physical generation', async (t) => {
  let now = Date.now()
  const { first, second } = await fixture(t, { now: () => now })
  const slot = await first.acquire(randomUUID())
  assert.ok(slot)
  assert.equal(await second.acquire(randomUUID()), null)
  await slot.bind({ admissionId: randomUUID(), attemptId: randomUUID(), fence: randomUUID(), resourceId: RESOURCE_ID })
  await slot.finish(false)
  now += 60_000
  assert.equal(await second.acquire(randomUUID()), null)
  assert.equal(await second.healthReason(), 'termination_uncertain')
  await second.confirmStopped()
  await second.flushTerminations(async (termination) => { assert.equal(termination.confirmed, true) })
  assert.ok(await first.acquire(randomUUID()))
})

test('malformed private intent metadata is refused before any new reservation', async (t) => {
  const { first, directory } = await fixture(t)
  const path = join(directory, 'poll-waiters.json')
  const valid = { hostId: randomUUID(), pid: process.pid, expiresAt: Date.now() + 60_000 }
  for (const malformed of [null, {}, [{ ...valid, pid: 0 }], [valid, valid], [{ ...valid, expiresAt: 'later' }]]) {
    await writeFile(path, JSON.stringify(malformed), { mode: 0o600 })
    await verifyInferenceTestState('secure-owner-only-file', path)
    await assert.rejects(first.acquire(randomUUID()), /poll-waiters\.json metadata needs repair/)
    await assert.rejects(lstat(join(directory, 'slot-0.json')), { code: 'ENOENT' })
  }
})

test('unsafe access to a private intent file is refused without admitting another host', async (t) => {
  const { first, directory, security } = await fixture(t)
  const path = join(directory, 'poll-waiters.json')
  await writeFile(path, '[]', { mode: 0o600 })
  await verifyInferenceTestState('secure-owner-only-file', path)
  let reader = first
  if (nativeInferenceSecurityHelper && process.platform === 'win32') {
    await execute('icacls', [path, '/grant', '*S-1-1-0:R'])
  } else {
    reader = await LocalInferenceCoordinator.open({ directory, security: {
      ...security, helper: async (command, target) => {
        if (command === 'verify-owner-only-file' && target === path) {
          assertStateSecurityHelperResponse(JSON.stringify({ code: 'EXECUTOR_STATE_SECURITY_REJECTED' }), target)
        }
        await verifyInferenceTestState(command, target)
      },
    } })
  }
  await assert.rejects(reader.acquire(randomUUID()), /EXECUTOR_STATE_SECURITY_REJECTED/)
  await assert.rejects(lstat(join(directory, 'slot-0.json')), { code: 'ENOENT' })
})

test('a reservation another host never bound expires after five minutes; a bound one never does', async (t) => {
  let now = Date.now()
  const { first, second } = await fixture(t, { now: () => now })
  const stale = await first.acquire(randomUUID())
  assert.ok(stale)
  const waiting = randomUUID()
  now += 4 * 60_000
  assert.equal(await second.acquire(waiting), null, 'Four minutes is still the owner\'s token to reconcile.')
  now += 2 * 60_000
  const admitted = await second.acquire(waiting)
  assert.ok(admitted, 'A token nobody reconciled in six minutes no longer holds the machine\'s slot.')
  await assert.rejects(stale.releaseIdle(), /fenced/)
  await admitted.bind({ ...ADMISSION, attemptId: randomUUID() })
  now += 60 * 60_000
  assert.equal(await first.acquire(randomUUID()), null, 'A bound slot is a generation and never expires.')
})

test('a legacy reservation written before reservedAt existed is dated by its last write', async (t) => {
  const { first, second, directory } = await fixture(t)
  const token = await first.acquire(randomUUID())
  assert.ok(token)
  const path = join(directory, 'slot-0.json')
  const legacy = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8')) as Record<string, unknown>
  delete legacy.reservedAt
  await writeFile(path, JSON.stringify(legacy))
  const old = new Date(Date.now() - 10 * 60_000)
  await (await import('node:fs/promises')).utimes(path, old, old)
  const admitted = await second.acquire(randomUUID())
  assert.ok(admitted, 'A ten-minute-old legacy token is stale by its write time.')
  await admitted.releaseIdle()
})
