import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ensureOwnerOnlyStateDirectory, secureOwnerOnlyStateFile } from '../src/state-security.js'
import { withStateMutationLock } from '../src/state-store.js'
import { verifyInferenceTestState } from './fixtures/local-inference-security.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const LOCK = 'executor-state-mutation.lock'
const BUSY = /already being updated/u

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-state-lock-'))
  const directory = await ensureOwnerOnlyStateDirectory(join(root, 'team'))
  return { directory, clean: () => rm(root, { recursive: true, force: true }) }
}

/** What a release before generation locks left behind: the holder's PID and nothing else. */
const leaveOldLock = async (directory: string, pid: number): Promise<string> => {
  const path = join(directory, LOCK)
  await writeFile(path, `${pid}\n`, { mode: 0o600 })
  await secureOwnerOnlyStateFile(path)
  return path
}

const finished = (): Promise<number> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  child.once('error', reject)
  child.once('exit', () => resolve(child.pid!))
})

const running = (): Promise<ChildProcess> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  child.once('error', reject)
  child.once('spawn', () => resolve(child))
})

test('a settings update cut short by a crash or an upgrade does not block the next one',
  { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
    const f = await fixture()
    try {
      await leaveOldLock(f.directory, await finished())
      assert.equal(await withStateMutationLock(f.directory, async () => 'saved'), 'saved')
      // The next update finds no lock, and nothing of the takeover is left in the team's folder.
      assert.equal(await withStateMutationLock(f.directory, async () => 'again'), 'again')
      assert.deepEqual(await readdir(f.directory), [])
    } finally { await f.clean() }
  })

test('an update that is really running holds the next one back, and one update runs at a time',
  { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
    const f = await fixture()
    const other = await running()
    try {
      await leaveOldLock(f.directory, other.pid!)
      await assert.rejects(withStateMutationLock(f.directory, async () => 'saved'), BUSY)
      await rm(join(f.directory, LOCK))
      await withStateMutationLock(f.directory, async () => {
        await assert.rejects(withStateMutationLock(f.directory, async () => 'nested'), BUSY)
      })
    } finally { other.kill(); await f.clean() }
  })

test('an old lock whose process number now belongs to something else is given up once it is stale',
  { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
    const f = await fixture()
    const other = await running()
    try {
      const path = await leaveOldLock(f.directory, other.pid!)
      const old = new Date(Date.now() - 11 * 60_000)
      await utimes(path, old, old)
      assert.equal(await withStateMutationLock(f.directory, async () => 'saved'), 'saved')
    } finally { other.kill(); await f.clean() }
  })

test('a running daemon retries a finished settings save’s failed release on the next save', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-settings-retry-'))
  let blockRead = false
  const options = {
    security: { platform: 'win32' as const, helper: async (...args: Parameters<typeof verifyInferenceTestState>) => {
      if (blockRead && args[0] === 'verify-owner-only-file' && args[1] === join(directory, LOCK)) {
        throw new Error('temporary verification failure')
      }
      return verifyInferenceTestState(...args)
    } },
    processes: { identify: async (pid: number) => ({ pid, startedAt: '100' }), isAlive: () => true },
    kernelBootId: async () => '11111111-1111-4111-8111-111111111111',
  }
  try {
    await ensureOwnerOnlyStateDirectory(directory, options.security)
    const save = () => withStateMutationLock(directory, async () => 'saved', options)
    await withStateMutationLock(directory, async () => { blockRead = true }, options)
    assert.deepEqual(await readdir(directory), [LOCK])
    await assert.rejects(save)
    blockRead = false
    assert.equal(await save(), 'saved')
    assert.deepEqual(await readdir(directory), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
