import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ensureOwnerOnlyStateDirectory, secureOwnerOnlyStateFile } from '../src/state-security.js'
import { withStateMutationLock } from '../src/state-store.js'
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
