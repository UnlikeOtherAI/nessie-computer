import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseSessionsArguments, runSessionsCommand } from '../src/session-cli.js'
import { readSessions, writeSessionsFile, type SessionView } from '../src/session-snapshot.js'
import { listSessionStops } from '../src/session-stops.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const skip = WINDOWS_STATE_HELPER_SKIP
const SESSION = '00000000-0000-4000-8000-00000000f001'

const working: SessionView[] = [{
  sessionId: SESSION, agentName: 'Sales agent', startedAt: '2026-11-08T12:00:00.000Z',
  commands: [
    { id: '00000000-0000-4000-8000-00000000f002', kind: 'program', status: 'running', program: 'npm', args: ['test'] },
    { id: '00000000-0000-4000-8000-00000000f003', kind: 'file', status: 'queued', operation: 'read', path: 'report.md' },
  ],
}]

const usage = (): never => { throw new Error('usage') }

test('sessions and session stop parse their own options and nothing else', () => {
  assert.deepEqual(parseSessionsArguments(['sessions', '--state-dir', '/s', '--json'], usage),
    { json: true, kind: 'sessions', stateDir: '/s' })
  assert.deepEqual(parseSessionsArguments(['session', 'stop', '--state-dir', '/s', '--id', SESSION], usage),
    { id: SESSION, json: false, kind: 'session-stop', stateDir: '/s' })
  assert.throws(() => parseSessionsArguments(['session', 'list', '--state-dir', '/s', '--id', SESSION], usage), /usage/u)
  assert.throws(() => parseSessionsArguments(['sessions', '--state-dir'], usage), /usage/u)
  assert.equal(parseSessionsArguments(['pause', '--state-dir', '/s'], usage), undefined)
})

const withStateDir = async (body: (stateDir: string) => Promise<void>): Promise<void> => {
  const stateDir = await ensureOwnerOnlyStateDirectory(await mkdtemp(join(tmpdir(), 'nessie-sessions-cli-')))
  try {
    await body(stateDir)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
}

test('sessions lists what the running daemon reports, and nothing once that daemon is gone', { skip }, async () => {
  await withStateDir(async (stateDir) => {
    const out: string[] = []
    assert.equal(await runSessionsCommand({ json: true, kind: 'sessions', stateDir }, (text) => { out.push(text) }), 0)
    assert.deepEqual(JSON.parse(out.join('')), [], 'no daemon has written a list')

    await writeSessionsFile(stateDir, working)
    out.length = 0
    await runSessionsCommand({ json: true, kind: 'sessions', stateDir }, (text) => { out.push(text) })
    assert.deepEqual(JSON.parse(out.join('')), working)

    out.length = 0
    await runSessionsCommand({ json: false, kind: 'sessions', stateDir }, (text) => { out.push(text) })
    assert.match(out.join(''), /Sales agent .*\n {2}running: npm test\n {2}waiting to start: report\.md\n/u)

    assert.deepEqual(await readSessions(stateDir, () => false), [], 'a list whose daemon is not alive says nothing')
  })
})

test('session stop saves the owner\'s stop for the daemon, and refuses an id it cannot stop', { skip }, async () => {
  await withStateDir(async (stateDir) => {
    const out: string[] = []
    const run = (id: string) => runSessionsCommand({ id, json: true, kind: 'session-stop', stateDir }, (text) => { out.push(text) })

    assert.equal(await run('../escape'), 1)
    assert.equal(JSON.parse(out.pop()!).error.code, 'SESSION_ID_INVALID')
    assert.equal(await run(SESSION), 1)
    assert.equal(JSON.parse(out.pop()!).error.code, 'SESSION_NOT_RUNNING')
    await assert.rejects(readdir(join(stateDir, 'session-stops')), { code: 'ENOENT' })

    await writeSessionsFile(stateDir, working)
    // No daemon applies it here, so the list printed after the wait is the one still saved.
    assert.equal(await run(SESSION), 0)
    assert.deepEqual(JSON.parse(out.pop()!), working)
    assert.deepEqual(await listSessionStops(stateDir), [SESSION])
  })
})
