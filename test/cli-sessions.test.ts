import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import type { CliContext } from '../src/cli-output.js'
import { runUserCli } from '../src/cli-user.js'
import { writeSessionsFile, type SessionView } from '../src/session-snapshot.js'
import { listSessionStops } from '../src/session-stops.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { saveExecutorState } from '../src/state-store.js'
import { fakeTeamNames } from './support/fake-team-names.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

/**
 * `nessie-computer sessions`: the Now working list across teams and its Stop,
 * against a team saved in a stand-in home folder whose running daemon's list
 * (`sessions.json`) this test writes, as that daemon would.
 */

const skip = WINDOWS_STATE_HELPER_SKIP
const SALES = '00000000-0000-4000-8000-0000000000b1'
const SESSION = '0b0c3a40-6f1e-4f7e-9d3b-2d1b8f1e4c11'

const working: SessionView[] = [{
  sessionId: SESSION, agentName: 'Sales agent', startedAt: '2026-11-08T12:00:00.000Z',
  commands: [
    { id: '00000000-0000-4000-8000-0000000000b2', kind: 'program', status: 'waiting_for_owner',
      program: 'docker', args: ['build', '.'], requestId: '00000000-0000-4000-8000-0000000000b3' },
    { id: '00000000-0000-4000-8000-0000000000b4', kind: 'browser', status: 'running', site: 'docs.example.com' },
  ],
}]

const team = async (home: string): Promise<string> => {
  const root = join(home, '.local', 'state', 'nessie-executor')
  await mkdir(root, { recursive: true })
  const stateDir = await ensureOwnerOnlyStateDirectory(join(root, SALES))
  const keys = generateKeyPairSync('ed25519')
  await saveExecutorState(stateDir, {
    apiBaseUrl: 'https://api.example.test',
    commandPolicy: { mode: 'allowlist', allowlist: [], denylist: [] },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.list', 'file.read'], profiles: ['workspace_sandbox'], revision: 1, workspaceFolders: ['work'],
    },
    executorId: SALES,
    machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    machinePublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    workspaceFolders: [{ name: 'work', path: await ensureOwnerOnlyStateDirectory(join(home, 'work')) }],
  })
  return stateDir
}

const run = async (home: string, args: string[]) => {
  let out = ''
  let err = ''
  const context: CliContext = { out: (text) => { out += text }, err: (text) => { err += text },
    stdin: Readable.from([]), interactive: false, ask: async () => '', platform: process.platform, home,
    now: () => new Date(), sleep: async () => undefined }
  const exit = await runUserCli(args, {
    context, namesApi: fakeTeamNames({ names: { [SALES]: { teamName: 'Sales', organizationName: 'Acme' } } }).api,
  })
  return { exit, out, err }
}

test('sessions lists what agents are doing in every team, and stops one by a short id', { skip, timeout: 60_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'nessie-cli-sessions-'))
    try {
      const stateDir = await team(home)
      assert.match((await run(home, ['sessions'])).out, /^No agent is working on this computer right now\.\n$/u)
      await writeSessionsFile(stateDir, working)

      const listed = await run(home, ['sessions', '--json'])
      assert.equal(listed.exit, 0, listed.err)
      assert.deepEqual(JSON.parse(listed.out), [{ executorId: SALES, team: 'Sales · Acme', ...working[0] }])
      const text = await run(home, ['sessions', 'list'])
      assert.equal(text.out, 'Sales agent in Sales · Acme (session 0b0c3a40)\n'
        + '  waiting for you: `docker build .`\n  browsing docs.example.com\n')

      assert.equal((await run(home, ['sessions', 'stop', 'ffffffff'])).exit, 1)
      assert.equal((await run(home, ['sessions', 'stop', '0b0'])).exit, 2, 'too short an id is a usage error')
      // No daemon applies the stop here; the stop it saved is what a running daemon reads.
      const stopped = await run(home, ['sessions', 'stop', '0b0c3a40'])
      assert.equal(stopped.exit, 0, stopped.err)
      assert.match(stopped.out, /^Stopped Sales agent's work in Sales · Acme\./u)
      assert.deepEqual(await listSessionStops(stateDir), [SESSION])
    } finally {
      await rm(home, { force: true, recursive: true })
    }
  })

test('with a state folder, sessions is the apps\' plumbing verb, as the real entry routes it', { skip, timeout: 60_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'nessie-cli-sessions-plumbing-'))
    try {
      const stateDir = await team(home)
      await writeSessionsFile(stateDir, working)
      const env = { ...process.env, HOME: home, USERPROFILE: home }
      delete env.NESSIE_EXECUTOR_PACKAGED_CLI
      const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
      const plumbing = spawnSync(process.execPath, ['--import', 'tsx', entry, 'sessions', '--state-dir', stateDir, '--json'],
        { encoding: 'utf8', env, timeout: 60_000 })
      assert.equal(plumbing.status, 0, plumbing.stderr)
      // The list this test's process wrote, unlabelled: the apps add their own team id.
      assert.deepEqual(JSON.parse(plumbing.stdout), working)
    } finally {
      await rm(home, { force: true, recursive: true })
    }
  })
