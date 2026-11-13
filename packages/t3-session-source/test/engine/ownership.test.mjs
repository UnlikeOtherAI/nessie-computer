import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile, stat, link, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { StateDirectoryLock, createSessionRuntimeLayers } from '@nessie/t3-session-source/engine'

const fixture = async () => {
  const parent = resolve(import.meta.dirname, '../../.artifacts/runtime-ownership')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'run-'))
  await writeFile(join(directory, 'server-owner.sqlite'), '', { mode: 0o600, flag: 'wx' })
  return directory
}
const engineUrl = new URL('../../dist/engine.js', import.meta.url).href
const code = body => `import { StateDirectoryLock } from ${JSON.stringify(engineUrl)}; ${body}`
const childProbe = directory => spawnSync(process.execPath, ['--max-old-space-size=512', '--input-type=module', '-e',
  code(`try { const lock = StateDirectoryLock.acquire(${JSON.stringify(directory)}); lock.close(); }
    catch (error) { console.error(error.code); process.exitCode = 7; }`)],
{ encoding: 'utf8', windowsHide: true, timeout: 15_000 })

test('exclusive writer survives a refused competing connection and reopens without deleting its lock', async () => {
  const directory = await fixture()
  const path = join(directory, 'server-owner.sqlite')
  const before = await stat(path, { bigint: true })
  const writer = StateDirectoryLock.acquire(directory)
  try {
    assert.throws(() => StateDirectoryLock.acquire(directory), { code: 'session_state_already_owned' })
    const other = childProbe(directory)
    assert.equal(other.error, undefined)
    assert.equal(other.status, 7, other.stderr)
    assert.match(other.stderr, /session_state_already_owned/u)
    writer.assertCurrent()
  } finally { writer.close() }
  writer.close()
  assert.throws(() => writer.assertCurrent(), { code: 'session_state_writer_lost' })
  const reopened = childProbe(directory)
  assert.equal(reopened.error, undefined)
  assert.equal(reopened.status, 0, reopened.stderr)
  const after = await stat(path, { bigint: true })
  assert.equal(after.ino, before.ino)
  assert.equal(after.dev, before.dev)
})

test('process loss releases the SQLite lock without deleting retained files', async () => {
  const directory = await fixture()
  const child = spawn(process.execPath, ['--max-old-space-size=512', '--input-type=module', '-e',
    code(`const lock = StateDirectoryLock.acquire(${JSON.stringify(directory)});
      process.stdout.write('acquired'); setInterval(() => lock.assertCurrent(), 1000);`)],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  const timeout = setTimeout(() => child.kill(), 15_000)
  try {
    const [chunk] = await Promise.race([once(child.stdout, 'data'), exited.then(() => {
      throw new Error('Synthetic lock owner exited before acquisition.')
    })])
    assert.equal(chunk.toString(), 'acquired')
    assert.equal(childProbe(directory).status, 7)
  } finally { child.kill(); await exited; clearTimeout(timeout) }
  const writer = StateDirectoryLock.acquire(directory)
  writer.assertCurrent()
  writer.close()
})

test('lock aliases are refused and replacement permanently invalidates the old handle', async () => {
  const directory = await fixture()
  const path = join(directory, 'server-owner.sqlite')
  const alias = join(directory, 'lock-alias')
  await link(path, alias)
  assert.throws(() => StateDirectoryLock.acquire(directory), { code: 'session_state_lock_shape_refused' })
  const fresh = await fixture()
  const original = join(fresh, 'server-owner.sqlite')
  const replaced = join(fresh, 'replaced.sqlite')
  const writer = StateDirectoryLock.acquire(fresh)
  try {
    try { await rename(original, replaced) }
    catch (error) {
      // Windows can refuse rename of an open SQLite handle itself. That is an
      // enforced physical refusal, not a skipped assertion of replacement handling.
      assert.equal(process.platform, 'win32')
      assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code))
      writer.assertCurrent()
      return
    }
    await writeFile(original, '', { flag: 'wx', mode: 0o600 })
    assert.throws(() => writer.assertCurrent(), { code: 'session_state_writer_lost' })
    assert.throws(() => writer.assertCurrent(), { code: 'session_state_writer_lost' })
  } finally { writer.close() }
})

test('executing composition refuses unbound production owners instead of substituting empty services', async () => {
  const result = await Effect.runPromise(Effect.exit(Effect.scoped(Layer.build(createSessionRuntimeLayers().layer))))
  assert.equal(Exit.isFailure(result), true)
})
