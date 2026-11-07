import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { PersonalNativeWriters } from '../src/personal-native-writers.js'
import { runPersonalNativeState } from '../src/personal-native-state-runner.js'
import { createPersonalStateMutation } from '../src/personal-state-mutation.js'
import type { StateSecurityHelper } from '../src/state-security.js'
import { acquirePersonalAdmissionLock } from '../src/personal-admission-lock.js'

// Transport/kernel fixtures exercise unknown-stop persistence; they cannot
// provide a production native factory, release signature or activation proof.
const writerFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-native-writer-'))
  const child = Object.assign(new EventEmitter(), { pid: 123456789,
    stdin: new PassThrough(), stdout: new PassThrough(), kill: () => false })
  let alive = true
  const processes = { identify: async (pid: number) => alive ? { pid, startedAt: '123' } : undefined,
    isAlive: () => alive }
  const helper: StateSecurityHelper = async (command, path) => {
    if (command === 'secure-directory') await mkdir(path, { recursive: true, mode: 0o700 })
    const entry = await lstat(path)
    assert.equal(entry.isSymbolicLink(), false)
    assert.equal(command === 'secure-directory' || command === 'verify-owner-only'
      ? entry.isDirectory() : entry.isFile(), true)
  }
  const security = { platform: 'win32' as const, helper }
  const journal = () => new PersonalNativeWriters(root, security, processes)
  // A separate adapter observes kernel death without the old transport ever
  // reporting close. Its journal must perform recovery, not race old cleanup.
  const stop = () => { alive = false }
  const close = () => { alive = false; child.emit('close', 1) }
  const clean = async () => {
    stop()
    await journal().execute(async () => undefined)
    await rm(root, { recursive: true, force: true })
  }
  return { root, child, journal, stop, close, clean }
}

test('a delayed pre-lock writer with unknown kill remains fenced across a new adapter', async () => {
  const fixture = await writerFixture()
  try {
    const finished = once(fixture.child.stdin, 'finish')
    const mutation = runPersonalNativeState('fixture', ['replace'], Buffer.from('fixture-bytes'), fixture.journal(),
      { spawn: () => fixture.child, timeoutMs: 2_000, stopWaitMs: 30 })
    await finished // Gate was complete, but the helper has not reached its kernel lock.
    await assert.rejects(mutation, /writer_unknown/u)
    const claims = await readdir(join(fixture.root, 'native-writers'))
    assert.equal(claims.filter((name) => name.endsWith('.json')).length, 1)
    let laterBarrierRan = false
    await assert.rejects(fixture.journal().execute(async () => { laterBarrierRan = true }), /writer_unknown/u)
    assert.equal(laterBarrierRan, false)
    // Even a delayed eventual publication cannot have a succeeding deletion
    // barrier in front of it. Only its actual exit permits reconciliation.
    fixture.stop()
    await fixture.journal().execute(async () => { laterBarrierRan = true })
    assert.equal(laterBarrierRan, true)
  } finally { await fixture.clean() }
})

test('stdin failure requests stop and keeps a claim when actual child exit is unknown', async () => {
  const fixture = await writerFixture()
  let stops = 0
  fixture.child.kill = () => { stops += 1; return false }
  try {
    const finished = once(fixture.child.stdin, 'finish')
    const mutation = runPersonalNativeState('fixture', ['replace'], Buffer.from('fixture-bytes'), fixture.journal(),
      { spawn: () => fixture.child, timeoutMs: 500, stopWaitMs: 30 })
    await finished
    fixture.child.stdin.emit('error', new Error('fixture transport failure'))
    await assert.rejects(mutation, /writer_unknown/u)
    assert.equal(stops, 1)
    await assert.rejects(fixture.journal().execute(async () => undefined), /writer_unknown/u)
  } finally { await fixture.clean() }
})

test('a cancellation with an observed child close releases its claim, never on kill request alone', async () => {
  const fixture = await writerFixture()
  fixture.child.kill = () => { queueMicrotask(fixture.close); return true }
  // Releasing the claim outlasts the stop wait, as its file I/O can on a busy
  // machine: the observed close decides, not the clock.
  const journal = fixture.journal()
  const execute = journal.execute.bind(journal)
  journal.execute = (work) => execute((track) => work(async (child) => {
    const release = await track(child)
    return async () => { await new Promise((settle) => { setTimeout(settle, 40) }); await release() }
  }))
  try {
    const mutation = runPersonalNativeState('fixture', ['replace'], Buffer.from('fixture-bytes'), journal,
      { spawn: () => fixture.child, timeoutMs: 2_000, stopWaitMs: 5 })
    await assert.rejects(mutation, /mutation_unknown/u)
    await fixture.journal().execute(async () => undefined)
    const claims = await readdir(join(fixture.root, 'native-writers'))
    assert.equal(claims.filter((name) => name.endsWith('.json')).length, 0)
  } finally { await fixture.clean() }
})

test('more than 256 abandoned metadata drafts recover before live-claim admission is bounded', async () => {
  const fixture = await writerFixture()
  try {
    await fixture.journal().execute(async () => undefined)
    const directory = join(fixture.root, 'native-writers')
    for (let index = 0; index < 300; index += 1) {
      await writeFile(join(directory, `${randomUUID()}.json.${process.pid}.${randomUUID()}.new`),
        'unpublished-fixture-metadata', { mode: 0o600 })
    }
    await fixture.journal().execute(async () => undefined)
    assert.deepEqual(await readdir(directory), [])
  } finally { await fixture.clean() }
})

test('POSIX barrier removes the private draft of a process killed before rename', async () => {
  if (process.platform === 'win32') {
    await assert.rejects(createPersonalStateMutation(), /native_unavailable/u)
    return
  }
  const adapter = await createPersonalStateMutation()
  const directory = join(adapter.root, 'test-fixtures', randomUUID())
  await adapter.ensureDirectory(directory)
  const target = join(directory, 'credential-fixture.json')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const draft = join(directory, `.state-draft-${hash(target)}`)
  const lockDirectory = join(adapter.root, 'state-mutation-locks', hash(directory))
  await adapter.ensureDirectory(lockDirectory)
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/personal-draft-crash.ts',
    import.meta.url)), lockDirectory, draft], { stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const [output] = await once(child.stdout, 'data')
    assert.equal(String(output).trim(), 'READY')
    const closed = once(child, 'close')
    assert.equal(child.kill('SIGKILL'), true)
    await closed
    await adapter.barrier(directory)
    await assert.rejects(stat(draft), { code: 'ENOENT' })
    await assert.rejects(stat(target), { code: 'ENOENT' })
    const lock = await acquirePersonalAdmissionLock(lockDirectory)
    await lock.release()
  } finally { child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }) }
})


test('POSIX mutations reject permissive protected ancestors above an existing private destination', async () => {
  if (process.platform === 'win32') {
    await assert.rejects(createPersonalStateMutation(), /native_unavailable/u)
    return
  }
  const adapter = await createPersonalStateMutation()
  const directory = join(adapter.root, 'test-fixtures', randomUUID())
  const descendant = join(directory, 'existing-private-child')
  await adapter.ensureDirectory(descendant)
  try {
    await chmod(directory, 0o755) // Only this fixture's directory; generic ~/.nessie is never modified.
    await assert.rejects(adapter.ensureDirectory(descendant), /accessible by other users|state_invalid/u)
    await assert.rejects(adapter.barrier(descendant), /accessible by other users|state_invalid/u)
    await assert.rejects(adapter.mutate(join(descendant, 'must-not-write.json'), {
      operation: 'replace', expectedDigest: null, bytes: Buffer.from('fixture-only'),
    }), /accessible by other users|state_invalid/u)
    await assert.rejects(stat(join(descendant, 'must-not-write.json')), { code: 'ENOENT' })
  } finally { await chmod(directory, 0o700); await rm(directory, { recursive: true, force: true }) }
})
