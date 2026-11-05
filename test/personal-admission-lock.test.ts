import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { acquirePersonalAdmissionLock, acquireOwnerStateLock, acquirePhysicalInferenceStateLock,
  type AdmissionProcessInspector } from '../src/personal-admission-lock.js'
import { ensureOwnerOnlyStateDirectory, secureOwnerOnlyStateFile } from '../src/state-security.js'
import { verifyInferenceTestState } from './fixtures/local-inference-security.js'

const security = { platform: 'win32' as const, helper: verifyInferenceTestState }
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-admission-'))
  await ensureOwnerOnlyStateDirectory(directory, security)
  return { directory, clean: () => rm(directory, { recursive: true, force: true }) }
}
const inspector = (other?: string, alive = false): AdmissionProcessInspector => ({
  identify: async (pid) => pid === process.pid ? { pid, startedAt: '100' }
    : other ? { pid, startedAt: other } : undefined,
  isAlive: (pid) => pid === process.pid || alive,
})
const seed = async (directory: string, path = 'admission.lock', token = randomUUID()) => {
  await writeFile(join(directory, path), JSON.stringify({ version: 1, pid: 999_999, startedAt: '10', token }), { mode: 0o600 })
  await secureOwnerOnlyStateFile(join(directory, path), security)
  return token
}

test('live generations and unreadable live owners cannot be stolen', async () => {
  const { directory, clean } = await fixture()
  try {
    const token = await seed(directory)
    for (const processes of [inspector('10', true), inspector(undefined, true)]) {
      await assert.rejects(acquirePersonalAdmissionLock(directory, { security, processes }), /admission_busy/u)
      assert.equal(JSON.parse(await readFile(join(directory, 'admission.lock'), 'utf8')).token, token)
    }
  } finally { await clean() }
})

test('PID reuse automatically reclaims the old generation without disturbing the new process', async () => {
  const { directory, clean } = await fixture()
  try {
    const old = await seed(directory)
    const lease = await acquirePersonalAdmissionLock(directory, { security, processes: inspector('11', true) })
    assert.notEqual(JSON.parse(await readFile(join(directory, 'admission.lock'), 'utf8')).token, old)
    await lease.release()
  } finally { await clean() }
})

test('concurrent stale recovery grants at most one live claim and recovers a crashed recovery owner', async () => {
  const { directory, clean } = await fixture()
  try {
    const token = await seed(directory)
    const recovery = `admission-recovery-${createHash('sha256').update(token).digest('hex')}.lock`
    await seed(directory, recovery)
    const options = { security, processes: inspector() }
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () =>
      acquirePersonalAdmissionLock(directory, options)))
    const leases = outcomes.filter((item): item is PromiseFulfilledResult<{ release: () => Promise<void> }> =>
      item.status === 'fulfilled')
    assert.equal(leases.length, 1)
    for (const item of outcomes) {
      if (item.status === 'rejected') assert.match(String(item.reason), /admission_busy/u)
    }
    await leases[0]!.value.release()
    await (await acquirePersonalAdmissionLock(directory, options)).release()
  } finally { await clean() }
})

for (const boundary of ['before', 'after']) {
  test(`a real process crash ${boundary} atomic owner publication recovers automatically`, { timeout: 60_000 }, async () => {
    const { directory, clean } = await fixture()
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL(
      './fixtures/personal-admission-crash-child.mjs', import.meta.url)), directory, boundary], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
    })
    const done = new Promise<void>((resolve) => { child.once('exit', () => resolve()) })
    try {
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
      assert.equal((await lines.next()).value, 'crash-boundary')
      if (boundary === 'after') {
        await assert.rejects(acquirePersonalAdmissionLock(directory, { security }), /admission_busy/u)
      }
      child.kill('SIGKILL')
      await done
      await (await acquirePersonalAdmissionLock(directory, { security })).release()
    } finally { child.kill(); await done; await clean() }
  })
}


test('historical raw PID recovery is physical-only and requires positive kernel absence', async () => {
  const { directory, clean } = await fixture()
  try {
    const path = join(directory, 'mutation.lock')
    await writeFile(path, '999999\n', { mode: 0o600 })
    await secureOwnerOnlyStateFile(path, security)
    for (const processes of [inspector('11', true), inspector(undefined, true), inspector('11', false)]) {
      await assert.rejects(acquirePhysicalInferenceStateLock(directory, { security, processes }), /admission_busy/u)
      assert.equal(await readFile(path, 'utf8'), '999999\n')
    }
    await assert.rejects(acquireOwnerStateLock(directory, 'mutation.lock', {
      security, processes: inspector(),
    }), /admission_invalid/u)
    await (await acquirePhysicalInferenceStateLock(directory, { security, processes: inspector() })).release()
  } finally { await clean() }
})

for (const bytes of ['', 'null', '[]', '1.5', '-1', '2147483648',
  '{"legacy":"physical_pid","pid":999999,"token":"forged"}']) {
  test(`physical recovery refuses malformed or ownerless claim ${JSON.stringify(bytes)}`, async () => {
    const { directory, clean } = await fixture()
    try {
      await writeFile(join(directory, 'mutation.lock'), bytes, { mode: 0o600 })
      await secureOwnerOnlyStateFile(join(directory, 'mutation.lock'), security)
      await assert.rejects(acquirePhysicalInferenceStateLock(directory, {
        security, processes: inspector(),
      }), /admission_invalid/u)
      assert.equal(await readFile(join(directory, 'mutation.lock'), 'utf8'), bytes)
    } finally { await clean() }
  })
}

test('legacy recovery preserves changed bytes during generation-locked reinspection', async () => {
  const { directory, clean } = await fixture()
  try {
    const path = join(directory, 'mutation.lock')
    await writeFile(path, '999999', { mode: 0o600 })
    await secureOwnerOnlyStateFile(path, security)
    let nextPid = 999998
    await assert.rejects(acquirePhysicalInferenceStateLock(directory, {
      security, processes: inspector(), afterRecoveryPublish: async () => {
        await writeFile(path, String(nextPid--), { mode: 0o600 })
      },
    }), /admission_busy/u)
    assert.equal(await readFile(path, 'utf8'), '999996')
  } finally { await clean() }
})


const OLD_BOOT = '11111111-1111-4111-8111-111111111111'
const NEXT_BOOT = '22222222-2222-4222-8222-222222222222'
test('boot-born locks recover after reboot even when PID and start ticks repeat', async () => {
  const { directory, clean } = await fixture()
  try {
    const path = join(directory, 'credential.lock')
    await writeFile(path, JSON.stringify({ version: 2, bootId: OLD_BOOT, pid: 999999,
      startedAt: '10', token: randomUUID() }), { mode: 0o600 })
    await secureOwnerOnlyStateFile(path, security)
    const lease = await acquireOwnerStateLock(directory, 'credential.lock', {
      security, processes: inspector('10', true), kernelBootId: async () => NEXT_BOOT,
    })
    const replacement = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(replacement.version, 2)
    assert.equal(replacement.bootId, NEXT_BOOT)
    await lease.release()
  } finally { await clean() }
})
test('same-boot and unreadable boot evidence cannot steal a live credential claim', async () => {
  const { directory, clean } = await fixture()
  try {
    const path = join(directory, 'credential.lock')
    const token = randomUUID()
    await writeFile(path, JSON.stringify({ version: 2, bootId: OLD_BOOT, pid: 999999,
      startedAt: '10', token }), { mode: 0o600 })
    await secureOwnerOnlyStateFile(path, security)
    let reads = 0
    for (const kernelBootId of [async () => OLD_BOOT, async () => ++reads === 1 ? OLD_BOOT : undefined]) {
      await assert.rejects(acquireOwnerStateLock(directory, 'credential.lock', {
        security, processes: inspector('10', true), kernelBootId,
      }), /admission_busy/u)
      assert.equal(JSON.parse(await readFile(path, 'utf8')).token, token)
    }
  } finally { await clean() }
})
