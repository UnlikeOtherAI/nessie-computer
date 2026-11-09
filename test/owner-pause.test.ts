import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseCommand } from '../src/cli-arguments.js'
import { createDaemonOwnerPause } from '../src/daemon-owner-pause.js'
import { ownerPausePath, readOwnerPause, setOwnerPaused } from '../src/owner-pause.js'
import { ensureOwnerOnlyStateDirectory, secureOwnerOnlyStateFile } from '../src/state-security.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const skip = WINDOWS_STATE_HELPER_SKIP
const stateDirectory = async (): Promise<string> =>
  ensureOwnerOnlyStateDirectory(await mkdtemp(join(tmpdir(), 'nessie-owner-pause-')))

test('pause persists an owner-only file that keeps its first since; resume removes it', { skip }, async () => {
  const stateDir = await stateDirectory()
  try {
    assert.equal(await readOwnerPause(stateDir), null)
    const first = await setOwnerPaused(stateDir, true, () => new Date('2026-11-08T10:00:00.000Z'))
    assert.deepEqual(first, { paused: true, since: '2026-11-08T10:00:00.000Z' })
    assert.deepEqual(JSON.parse(await readFile(ownerPausePath(stateDir), 'utf8')), first)
    if (process.platform !== 'win32') assert.equal((await stat(ownerPausePath(stateDir))).mode & 0o777, 0o600)
    // Pausing again keeps the pause that is already there.
    assert.deepEqual(await setOwnerPaused(stateDir, true, () => new Date('2026-11-08T11:00:00.000Z')), first)
    assert.equal(await setOwnerPaused(stateDir, false), null)
    assert.equal(await readOwnerPause(stateDir), null)
    // Resuming a team that is not paused is not an error.
    assert.equal(await setOwnerPaused(stateDir, false), null)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('a pause file that cannot be read counts as paused, and the daemon reads it so', { skip }, async () => {
  const stateDir = await stateDirectory()
  try {
    await writeFile(ownerPausePath(stateDir), '{"paused":', { mode: 0o600 })
    await secureOwnerOnlyStateFile(ownerPausePath(stateDir))
    assert.equal((await readOwnerPause(stateDir))?.paused, true)
    const daemon = createDaemonOwnerPause(stateDir, () => undefined)
    await daemon.load()
    assert.equal(daemon.paused(), true)
    // The owner's pause replaces the damaged file with a real one.
    const replaced = await setOwnerPaused(stateDir, true)
    assert.notEqual(replaced?.since, new Date(0).toISOString())
    assert.equal(await setOwnerPaused(stateDir, false), null)
    assert.equal(await daemon.load(), true)
    assert.equal(daemon.paused(), false)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('an older Nessie that refuses the field hears no pause for the rest of that connection only', { skip }, async () => {
  const stateDir = await stateDirectory()
  try {
    await setOwnerPaused(stateDir, true)
    const logged: string[] = []
    const daemon = createDaemonOwnerPause(stateDir, (message) => { logged.push(message) })
    await daemon.load()
    const first = daemon.report('7')
    assert.equal(first.paused, true)
    first.refused()
    first.refused()
    assert.equal(daemon.report('7').paused, false)
    assert.equal(daemon.paused(), true, 'the team stays paused where it is enforced')
    assert.equal(logged.length, 1)
    // A reconnect may meet an upgraded Nessie: it is told again.
    assert.equal(daemon.report('8').paused, true)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('the pause, request and answer verbs take exactly their own options', () => {
  assert.deepEqual(parseCommand(['pause', '--state-dir', '/s']), { json: false, kind: 'pause', stateDir: '/s' })
  assert.deepEqual(parseCommand(['resume', '--state-dir', '/s', '--json']), { json: true, kind: 'resume', stateDir: '/s' })
  assert.deepEqual(parseCommand(['program-requests', '--state-dir', '/s', '--json']),
    { json: true, kind: 'program-requests', stateDir: '/s' })
  assert.deepEqual(parseCommand(['program-request', 'answer', '--state-dir', '/s', '--id', 'x', '--answer', 'always']),
    { answer: 'always', id: 'x', json: false, kind: 'program-request-answer', stateDir: '/s' })
  assert.throws(() => parseCommand(['program-request', 'answer', '--state-dir', '/s', '--id', 'x', '--answer', 'maybe']),
    /Usage/u)
  assert.throws(() => parseCommand(['program-request', 'list', '--state-dir', '/s', '--id', 'x', '--answer', 'once']),
    /Usage/u)
  assert.throws(() => parseCommand(['audience', '--state-dir', '/s', '--json']), /Unknown|Usage/u)
  assert.throws(() => parseCommand(['pause', '--state-dir', '/s', '--all']), /Usage/u)
})
