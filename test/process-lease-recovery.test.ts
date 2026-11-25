import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { legacyLifecycleOwnerAbsent } from '../src/lifecycle-legacy-owner.js'
import { acquireExecutorProcessLease, executorProcessLeaseState } from '../src/process-lease.js'
import { ensureOwnerOnlyStateDirectory, secureOwnerOnlyStateFile } from '../src/state-security.js'
import { verifyInferenceTestState } from './fixtures/local-inference-security.js'

const security = { platform: 'win32' as const, helper: verifyInferenceTestState }
const boot = '11111111-1111-4111-8111-111111111111'
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-process-lease-'))
  await ensureOwnerOnlyStateDirectory(directory, security)
  return { directory, clean: () => rm(directory, { recursive: true, force: true }) }
}
const processes = {
  identify: async (pid: number) => ({ pid, startedAt: pid === process.pid ? '100' : '20' }),
  isAlive: () => true,
}
const options = { security, processes, kernelBootId: async () => boot, legacyOwnerAbsent: async () => false }
const names = ['daemon.pid', 'pairing-operation.pid', 'pairing-activation.pid'] as const
const seed = async (directory: string, name: string) => {
  const claim = { version: 2, bootId: boot, pid: 999999, startedAt: '10', token: randomUUID() }
  await writeFile(join(directory, name), JSON.stringify(claim), { mode: 0o600 })
  await secureOwnerOnlyStateFile(join(directory, name), security)
}

for (const name of names) {
  test(name + ': PID reuse agrees with status, recovers and never signals the replacement', async () => {
    const f = await fixture()
    try {
      await seed(f.directory, name)
      assert.equal(await executorProcessLeaseState(f.directory, name, options), 'dead')
      const lock = await acquireExecutorProcessLease(f.directory, name, options)
      assert.equal(await executorProcessLeaseState(f.directory, name, options), 'live')
      await assert.rejects(acquireExecutorProcessLease(f.directory, name, options), /ALREADY_RUNNING|Pairing is busy/u)
      const claim = JSON.parse(await readFile(join(f.directory, name), 'utf8'))
      assert.equal(claim.pid, process.pid)
      assert.equal(claim.startedAt, '100')
      await lock.release()
      assert.equal(await executorProcessLeaseState(f.directory, name, options), 'absent')
      // The only process dependency exposes read-only identity/existence; no signal API is present.
      assert.equal((await processes.identify(999999)).startedAt, '20')
    } finally { await f.clean() }
  })
}

test('an exited daemon with a retained Windows birth record can restart', async () => {
  const f = await fixture()
  const retained = { ...options, processes: {
    identify: async (pid: number) => ({ pid, startedAt: pid === process.pid ? '100' : '10' }),
    isAlive: (pid: number) => pid === process.pid,
  } }
  try {
    await seed(f.directory, 'daemon.pid')
    assert.equal(await executorProcessLeaseState(f.directory, 'daemon.pid', retained), 'dead')
    const lease = await acquireExecutorProcessLease(f.directory, 'daemon.pid', retained)
    assert.equal(await executorProcessLeaseState(f.directory, 'daemon.pid', retained), 'live')
    await lease.release()
  } finally { await f.clean() }
})

test('a paused stale reclaimer excludes competitors and release cannot erase a replacement', async () => {
  const f = await fixture()
  let resume!: () => void
  let entered!: () => void
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
  const resumePromise = new Promise<void>((resolve) => { resume = resolve })
  try {
    await seed(f.directory, 'daemon.pid')
    const pending = acquireExecutorProcessLease(f.directory, 'daemon.pid', {
      ...options, afterRecoveryPublish: async () => { entered(); await resumePromise },
    })
    await enteredPromise
    await assert.rejects(acquireExecutorProcessLease(f.directory, 'daemon.pid', options), /ALREADY_RUNNING/u)
    resume()
    const owner = await pending
    assert.equal(await executorProcessLeaseState(f.directory, 'daemon.pid', options), 'live')
    await seed(f.directory, 'daemon.pid')
    const replacement = await readFile(join(f.directory, 'daemon.pid'), 'utf8')
    await assert.rejects(owner.release(), /admission_fenced/u)
    assert.equal(await readFile(join(f.directory, 'daemon.pid'), 'utf8'), replacement)
  } finally { resume(); await f.clean() }
})

test('publication failure leaves no empty canonical claim; unknown legacy identity stays protected', async () => {
  const f = await fixture()
  try {
    await assert.rejects(acquireExecutorProcessLease(f.directory, 'pairing-operation.pid', {
      ...options, beforePublish: async () => { throw new Error('simulated termination') },
    }), /simulated termination/u)
    assert.equal(await executorProcessLeaseState(f.directory, 'pairing-operation.pid', options), 'absent')
    await (await acquireExecutorProcessLease(f.directory, 'pairing-operation.pid', options)).release()
    await writeFile(join(f.directory, 'daemon.pid'), '999999\n', { mode: 0o600 })
    await secureOwnerOnlyStateFile(join(f.directory, 'daemon.pid'), security)
    assert.equal(await executorProcessLeaseState(f.directory, 'daemon.pid', options), 'unknown')
    await assert.rejects(acquireExecutorProcessLease(f.directory, 'daemon.pid', options), /ALREADY_RUNNING/u)
    assert.equal(await readFile(join(f.directory, 'daemon.pid'), 'utf8'), '999999\n')
  } finally { await f.clean() }
})

test('a legacy PID now owned by another OS principal recovers only through serialized lifecycle recovery', async () => {
  const f = await fixture()
  try {
    for (const name of names) {
      await writeFile(join(f.directory, name), '999999\n', { mode: 0o600 })
      await secureOwnerOnlyStateFile(join(f.directory, name), security)
      const recovered = { ...options, legacyOwnerAbsent: async (pid: number, birth?: string) => {
        assert.equal(pid, 999999); assert.equal(birth, '20'); return true
      } }
      assert.equal(await executorProcessLeaseState(f.directory, name, recovered), 'dead')
      const lease = await acquireExecutorProcessLease(f.directory, name, recovered)
      assert.equal(await executorProcessLeaseState(f.directory, name, recovered), 'live')
      await lease.release()
      assert.equal((await processes.identify(999999)).startedAt, '20')
    }
  } finally { await f.clean() }
})

test('legacy Windows metadata never retires the current account or an unknown generation', async () => {
  assert.equal(await legacyLifecycleOwnerAbsent(process.pid), false)
  assert.equal(await legacyLifecycleOwnerAbsent(process.pid, '1'), false)
  assert.equal(await legacyLifecycleOwnerAbsent(-1), false)
})
