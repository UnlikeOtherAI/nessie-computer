import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { LocalInferenceCoordinator } from '../src/local-inference-coordinator.js'
import { assertStateSecurityHelperResponse } from '../src/state-security.js'
import {
  nativeInferenceSecurityHelper as nativeHelper, verifyInferenceTestState as verify,
} from './fixtures/local-inference-security.js'

const execute = promisify(execFile)
const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

const fixture = async (t: test.TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-lock-recovery-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const held = gate()
  const release = gate()
  let holdMutation = false
  let beforeVerifyLock: (() => Promise<void>) | undefined
  const first = await LocalInferenceCoordinator.open({ directory, security: {
    platform: 'win32', helper: async (command, path) => {
      if (holdMutation && command === 'secure-owner-only-file' && basename(path).startsWith('control.json.')) {
        held.release()
        await release.promise
      }
      await verify(command, path)
    },
  } })
  const second = await LocalInferenceCoordinator.open({ directory, security: {
    platform: 'win32', helper: async (command, path) => {
      if (command === 'verify-owner-only-file' && basename(path) === 'mutation.lock') await beforeVerifyLock?.()
      await verify(command, path)
    },
  } })
  const resourceId = randomUUID()
  const control = (revision: number) => ({ resourceId, capacity: 1, controlRevision: revision,
    paused: false, healthReason: null })
  return {
    directory, first, second, control,
    beforeVerify: (hook: () => Promise<void>) => { beforeVerifyLock = hook },
    hold: async () => {
      holdMutation = true
      const pending = first.syncControl(control(1))
      await held.promise
      return { pending, release: release.release }
    },
  }
}

test('another host releasing its mutex between shape and native verification retries the mutation', async (t) => {
  const { directory, second, control, hold, beforeVerify } = await fixture(t)
  const owner = await hold()
  let raced = false
  beforeVerify(async () => {
    if (raced) return
    raced = true
    owner.release()
    await owner.pending
    await assert.rejects(lstat(join(directory, 'mutation.lock')), { code: 'ENOENT' })
  })
  try { await second.syncControl(control(2)) }
  finally { owner.release(); await owner.pending }
  assert.equal(raced, true)
  assert.equal((await second.control()).controlRevision, 2)
})

test('an existing mutex with a native I/O failure is not treated as absence', async (t) => {
  const { directory, second, control, beforeVerify } = await fixture(t)
  const path = join(directory, 'mutation.lock')
  await writeFile(path, String(process.pid), { mode: 0o600 })
  beforeVerify(async () => {
    assertStateSecurityHelperResponse(JSON.stringify({ code: 'EXECUTOR_STATE_SECURITY_IO_FAILURE' }), path)
  })
  await assert.rejects(second.syncControl(control(1)), /EXECUTOR_STATE_SECURITY_IO_FAILURE/)
  assert.equal(await readFile(path, 'utf8'), String(process.pid))
})

test('a mutex with unsafe access is refused and never reclaimed', async (t) => {
  const { directory, second, control, beforeVerify } = await fixture(t)
  const path = join(directory, 'mutation.lock')
  await writeFile(path, String(process.pid), { mode: 0o600 })
  if (nativeHelper && process.platform === 'win32') await execute('icacls', [path, '/grant', '*S-1-1-0:R'])
  else beforeVerify(async () => {
    assertStateSecurityHelperResponse(JSON.stringify({ code: 'EXECUTOR_STATE_SECURITY_REJECTED' }), path)
  })
  await assert.rejects(second.syncControl(control(1)), /EXECUTOR_STATE_SECURITY_REJECTED/)
  assert.equal(await readFile(path, 'utf8'), String(process.pid))
})

test('a live owner remains authoritative while another host checks its lock', async (t) => {
  const { directory, second, control, hold, beforeVerify } = await fixture(t)
  const owner = await hold()
  const original = await readFile(join(directory, 'mutation.lock'), 'utf8')
  assert.equal(JSON.parse(original).pid, process.pid)
  let recoveries = 0
  beforeVerify(async () => {
    recoveries += 1
    if (recoveries === 2) throw new Error('Live mutex remained occupied')
  })
  try {
    await assert.rejects(second.syncControl(control(2)), /Live mutex remained occupied/)
    assert.equal(await readFile(join(directory, 'mutation.lock'), 'utf8'), original)
  } finally { owner.release(); await owner.pending }
  assert.equal(recoveries, 2)
})

test('recovery never deletes a replacement inode using the old lock observation', async (t) => {
  const { directory, second, control, beforeVerify } = await fixture(t)
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
  assert.equal(dead.status, 0)
  const path = join(directory, 'mutation.lock')
  await writeFile(path, String(dead.pid), { mode: 0o600 })
  const previous = await lstat(path)
  let recoveries = 0
  let replacementInode = 0
  beforeVerify(async () => {
    recoveries += 1
    if (recoveries === 1) {
      await rename(path, `${path}.retired`)
      await writeFile(path, String(dead.pid), { mode: 0o600 })
      replacementInode = (await lstat(path)).ino
      assert.notEqual(replacementInode, previous.ino)
    } else throw new Error('Replacement inode survived the stale recovery')
  })
  await assert.rejects(second.syncControl(control(1)), /Replacement inode survived the stale recovery/)
  assert.equal((await lstat(path)).ino, replacementInode)
  assert.equal(recoveries, 2)
})
