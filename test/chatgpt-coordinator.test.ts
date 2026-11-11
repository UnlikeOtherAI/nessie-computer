import { verifyInferenceTestState } from './fixtures/local-inference-security.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalInferenceCoordinator } from '../src/local-inference-coordinator.js'
import type { ChatgptInferenceSource } from '../src/chatgpt-auth-provider.js'
import {
  cloudCapacityFileDigest, posixCloudCapacityMutation, type CloudCapacityMutation,
  syncCloudCapacityDirectory,
} from '../src/cloud-capacity-state.js'
import type { AdmissionProcessInspector } from '../src/personal-admission-lock.js'

const source: ChatgptInferenceSource = { kind: 'chatgpt', processing: 'openai_cloud', billingSource: 'personal_plan',
  profileId: '00000000-0000-4000-8000-000000000001', accountGeneration: 2, consentRevision: 3 }
const fixture = async (t: test.TestContext, mutate?: (next: CloudCapacityMutation) => CloudCapacityMutation,
  processes?: AdmissionProcessInspector, barrier?: (directory: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-cloud-capacity-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const security = process.platform === 'win32' ? { helper: verifyInferenceTestState } : {}
  const directory = join(root, 'cloud')
  await mkdir(directory, { mode: 0o700 })
  await mkdir(join(root, 'physical'), { mode: 0o700 })
  const nativeFixture: CloudCapacityMutation = async (path, input) => {
    assert.equal(await cloudCapacityFileDigest(path), input.expectedDigest)
    if (input.operation === 'delete') { await unlink(path); return }
    const draft = `${path}.fixture-new`
    const handle = await open(draft, 'wx', 0o600)
    try { await handle.writeFile(input.bytes); await handle.sync() } finally { await handle.close() }
    await rename(draft, path)
  }
  const base = process.platform === 'win32' ? nativeFixture : posixCloudCapacityMutation(security)
  const cloudBarrier = barrier ?? (process.platform === 'win32' ? async () => undefined : syncCloudCapacityDirectory)
  const options = { directory, security, cloudMutation: mutate?.(base) ?? base, cloudBarrier, processes }
  return { cloud: await LocalInferenceCoordinator.openChatgpt(source, options), options,
    physical: await LocalInferenceCoordinator.open({ directory: join(root, 'physical'), security }) }
}
const termination = () => ({ inferenceSource: source, attemptId: randomUUID(), admissionId: randomUUID(),
  fence: randomUUID(), resourceId: randomUUID() })

test('cloud unknown releases local transport concurrency while retaining an unconfirmed durable receipt', async (t) => {
  const { cloud, physical, options } = await fixture(t)
  const local = await physical.acquire()
  assert.ok(local)
  await local.bind({ ...termination(), inferenceSource: undefined })
  await local.finish(false)
  const lease = await cloud.acquire()
  assert.ok(lease)
  const identity = termination()
  await lease.bind(identity)
  await lease.finish(false)
  assert.equal(await cloud.healthReason(), null)
  assert.equal(await physical.healthReason(), 'termination_uncertain')
  assert.equal(await physical.acquire(), null)
  await assert.rejects(cloud.confirmStopped(), /cannot confirm/)
  await assert.rejects(cloud.flushTerminations(async () => { throw new Error('offline') }), /offline/)
  const restarted = await LocalInferenceCoordinator.openChatgpt(source, options)
  const next = await restarted.acquire()
  assert.ok(next, 'a different cloud root can use the profile while prior liability remains unknown')
  await next.releaseIdle()
  const receipts: unknown[] = []
  await restarted.flushTerminations(async (receipt) => { receipts.push(receipt) })
  assert.deepEqual(receipts, [{ ...identity, confirmed: false }])
  await restarted.flushTerminations(async () => { assert.fail('acknowledged receipt must not repeat') })
})

test('exact source is bound to pool, control and admission; a cloud directory cannot become physical', async (t) => {
  const { cloud, options } = await fixture(t)
  await assert.rejects(LocalInferenceCoordinator.open(options), /cannot become physical/)
  await assert.rejects(LocalInferenceCoordinator.openChatgpt({ ...source, accountGeneration: 3 }, options),
    /source needs repair/)
  const control = { resourceId: randomUUID(), capacity: 1, controlRevision: 1, paused: false, healthReason: null }
  await assert.rejects(cloud.syncControl(control), /source does not match/)
  await cloud.syncControl({ ...control, inferenceSource: source })
  const lease = await cloud.acquire()
  assert.ok(lease)
  await assert.rejects(lease.bind({ ...termination(), inferenceSource: undefined }), /source does not match/)
  await lease.releaseIdle()
})

test('dead cloud transport preserves unknown or already-recorded completion', async (t) => {
  const { cloud, options } = await fixture(t)
  const lease = await cloud.acquire()
  assert.ok(lease)
  const identity = termination()
  await lease.bind(identity)
  const slotPath = join(options.directory, 'slot-0.json')
  const slot = JSON.parse(await readFile(slotPath, 'utf8')) as Record<string, unknown>
  // Structural crash fixture: durable running slot belongs to an absent process.
  await writeFile(slotPath, JSON.stringify({ ...slot, pid: 0 }))
  const receipts: unknown[] = []
  await cloud.flushTerminations(async (receipt) => { receipts.push(receipt) })
  assert.deepEqual(receipts, [{ ...identity, confirmed: false }])
  const next = await cloud.acquire()
  assert.ok(next)
  const completed = termination()
  await next.bind(completed)
  const interrupted = JSON.parse(await readFile(slotPath, 'utf8')) as Record<string, unknown>
  await writeFile(join(options.directory, `termination-${next.requestId}.json`),
    JSON.stringify({ version: 1, revision: 1, termination: { ...completed, confirmed: true } }), { mode: 0o600 })
  await writeFile(slotPath, JSON.stringify({ ...interrupted, pid: 0 }))
  await cloud.flushTerminations(async (receipt) => { assert.deepEqual(receipt, { ...completed, confirmed: true }) })
  assert.ok(await cloud.acquire())
})

test('receipt publication survives live slot deletion failure and is cleaned before acknowledgement', async (t) => {
  let failDelete = true
  const { cloud, options } = await fixture(t, (next) => async (path, input) => {
    if (input.operation === 'delete' && path.endsWith('slot-0.json') && failDelete) {
      failDelete = false; throw new Error('injected slot deletion failure')
    }
    await next(path, input)
  })
  const lease = await cloud.acquire()
  assert.ok(lease)
  const identity = termination()
  await lease.bind(identity)
  await assert.rejects(lease.finish(true), /injected slot deletion/)
  const pending = JSON.parse(await readFile(join(options.directory, `termination-${lease.requestId}.json`), 'utf8'))
  assert.equal(pending.termination.confirmed, true)
  await cloud.flushTerminations(async (receipt) => {
    await assert.rejects(readFile(join(options.directory, 'slot-0.json')), { code: 'ENOENT' })
    assert.deepEqual(receipt, { ...identity, confirmed: true })
  })
  await assert.rejects(lease.finish(false), { name: 'LocalInferenceSlotFencedError' })
  const next = await cloud.acquire()
  assert.ok(next)
  await next.releaseIdle()
  await cloud.flushTerminations(async () => { assert.fail('completed receipt must not become unknown later') })
})

test('cloud PID reuse releases only the abandoned transport; unreadable live identity remains occupied', async (t) => {
  const inspector: AdmissionProcessInspector = {
    identify: async (pid) => pid === process.pid ? { pid, startedAt: '100' } : undefined,
    isAlive: () => true,
  }
  const { cloud, options } = await fixture(t, undefined, inspector)
  const lease = await cloud.acquire()
  assert.ok(lease)
  await lease.bind(termination())
  const path = join(options.directory, 'slot-0.json')
  const slot = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFile(path, JSON.stringify({ ...slot, processStartedAt: '99' }))
  const next = await cloud.acquire()
  assert.ok(next, 'different kernel process generation releases old local ownership')
  await next.releaseIdle()
  const unknown = await cloud.acquire()
  assert.ok(unknown)
  await unknown.bind(termination())
  const live = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFile(path, JSON.stringify({ ...live, pid: 123456, processStartedAt: '10' }))
  assert.equal(await cloud.acquire(), null, 'missing readable identity does not establish absence')
})

test('post-unlink durability failure is retried before an absent slot can submit its receipt', async (t) => {
  let failAfterUnlink = true
  let barrierAvailable = true
  let barriers = 0
  let submissions = 0
  const { cloud } = await fixture(t, (next) => async (path, input) => {
    if (failAfterUnlink && input.operation === 'delete' && path.endsWith('slot-0.json')) {
      failAfterUnlink = false
      await unlink(path)
      throw new Error('injected post-unlink directory failure')
    }
    await next(path, input)
  }, undefined, async (directory) => {
    barriers++
    if (!barrierAvailable) throw new Error('namespace durability unconfirmed')
    if (process.platform !== 'win32') await syncCloudCapacityDirectory(directory)
  })
  const lease = await cloud.acquire()
  assert.ok(lease)
  const identity = termination()
  await lease.bind(identity)
  barrierAvailable = false
  await assert.rejects(lease.finish(true), /post-unlink directory/)
  await assert.rejects(cloud.flushTerminations(async () => { submissions++ }), /durability unconfirmed/)
  assert.equal(submissions, 0)
  const barriersBeforeRetry = barriers
  barrierAvailable = true
  await cloud.flushTerminations(async (receipt) => {
    assert.ok(barriers > barriersBeforeRetry, 'receipt submission follows a fresh confirmed namespace barrier')
    assert.deepEqual(receipt, { ...identity, confirmed: true })
    submissions++
  })
  assert.equal(submissions, 1)
})

test('a plan given two turns takes two at once, makes a third wait and frees a slot as each ends', async (t) => {
  const { cloud } = await fixture(t)
  const resourceId = randomUUID()
  await cloud.syncControl({ resourceId, capacity: 2, controlRevision: 1, paused: false, healthReason: null,
    inferenceSource: source })
  const first = await cloud.acquire()
  const second = await cloud.acquire()
  assert.ok(first)
  assert.ok(second)
  assert.notEqual(first.requestId, second.requestId)
  await first.bind({ ...termination(), resourceId })
  await second.bind({ ...termination(), resourceId })
  assert.equal(await cloud.acquire(), null, 'both turns are taken')
  await first.finish(true)
  await cloud.flushTerminations(async () => undefined)
  const third = await cloud.acquire()
  assert.ok(third, 'a finished turn frees its slot while the other still runs')
  await third.releaseIdle()
  await second.finish(true)
  await cloud.flushTerminations(async () => undefined)
})
