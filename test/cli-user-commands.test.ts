import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import type { CliContext } from '../src/cli-output.js'
import { isUserCommand, runUserCli } from '../src/cli-user.js'
import { localCommandPolicyOf } from '../src/command-policy.js'
import { existingSessionsEnabled } from '../src/existing-session/settings.js'
import { readOwnerPause } from '../src/owner-pause.js'
import { allProgramTrust } from '../src/program-trust.js'
import { openProgramRequestStore } from '../src/program-requests.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { loadExecutorState, saveExecutorState } from '../src/state-store.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

/**
 * The commands a person types, run against teams saved in a stand-in home
 * folder: each one reads and writes through the operations the apps' plumbing
 * verbs use, so what it saved is checked with those same readers.
 */

const skip = WINDOWS_STATE_HELPER_SKIP

const NAMES: Record<string, { teamName: string; organizationName: string }> = {}

const team = async (home: string, executorId: string, names: { teamName: string; organizationName: string }) => {
  const root = join(home, '.local', 'state', 'nessie-executor')
  await mkdir(root, { recursive: true })
  const stateDir = await ensureOwnerOnlyStateDirectory(join(root, executorId))
  const folder = await ensureOwnerOnlyStateDirectory(join(home, `work-${executorId.slice(-4)}`))
  const keys = generateKeyPairSync('ed25519')
  await saveExecutorState(stateDir, {
    apiBaseUrl: 'https://api.example.test',
    commandPolicy: { mode: 'allowlist', allowlist: [], denylist: [], trusted: allProgramTrust() },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.list', 'file.read'], profiles: ['workspace_sandbox'], revision: 1, workspaceFolders: ['work'],
    },
    executorId,
    machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    machinePublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    workspaceFolders: [{ name: 'work', path: folder }],
  })
  NAMES[stateDir] = names
  return stateDir
}

/** Removes the folder as `unpairExecutor` does, without its sign-off or the machine's ChatGPT guard. */
const unpair = async (stateDir: string) => {
  await rm(stateDir, { force: true, recursive: true })
  return { status: 'removed' as const, signedOff: true }
}

const run = async (home: string, args: string[], platform: NodeJS.Platform = process.platform) => {
  let out = ''
  let err = ''
  const context: CliContext = { out: (text) => { out += text }, err: (text) => { err += text },
    stdin: Readable.from([]),
    interactive: false, ask: async () => '', platform, home, now: () => new Date(), sleep: async () => undefined,
    run: async () => ({ code: null, stdout: '', stderr: '' }) }
  const exit = await runUserCli(args, { context, unpair,
    nameLookup: async (found) => (found.route === 'local' ? NAMES[found.stateDir] ?? {} : {}) })
  return { exit, out, err, json: () => JSON.parse(out) as unknown }
}

/** The real entry in a child process, with `home` as its home folder. */
const spawned = (home: string, args: string[]) => {
  const env = { ...process.env, HOME: home, USERPROFILE: home }
  delete env.NESSIE_EXECUTOR_PACKAGED_CLI
  return spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url)), ...args],
    { encoding: 'utf8', env, timeout: 60_000 })
}

const SALES = '00000000-0000-4000-8000-0000000000a1'
const RESEARCH = '00000000-0000-4000-8000-0000000000a2'

test('teams, status, pause and resume find the team and report it in the window\'s words', { skip, timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-cli-user-'))
  try {
    const stateDir = await team(home, SALES, { teamName: 'Sales', organizationName: 'Acme' })
    const teams = await run(home, ['teams', '--json'])
    assert.equal(teams.exit, 0, teams.err)
    assert.deepEqual((teams.json() as Array<{ label: string; status: string; executorId: string }>)
      .map(({ label, status, executorId }) => ({ label, status, executorId })),
    [{ label: 'Sales · Acme', status: 'not_connected', executorId: SALES }])
    assert.equal((await run(home, ['pause'])).exit, 0)
    assert.notEqual(await readOwnerPause(stateDir), null)
    const paused = await run(home, ['status'])
    assert.match(paused.out, /Sales · Acme\s+Paused/u)
    const resumed = await run(home, ['resume', '--team', 'sales', '--json'])
    assert.equal(resumed.exit, 0, resumed.err)
    assert.deepEqual((resumed.json() as Array<{ paused: boolean }>).map((row) => row.paused), [false])
    assert.equal(await readOwnerPause(stateDir), null)
  } finally { await rm(home, { force: true, recursive: true }) }
})

test('access changes save through the configure writer and show before and after', { skip, timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-cli-access-'))
  try {
    const stateDir = await team(home, SALES, { teamName: 'Sales', organizationName: 'Acme' })
    const allow = await run(home, ['access', 'programs', 'allow', 'npm'])
    assert.equal(allow.exit, 0, allow.err)
    assert.match(allow.out, /^Was: Only these: Apps from UnlikeOtherAI, Claude Code, Codex, T3 Code\nNow: .*npm \*/u)
    assert.equal((await run(home, ['access', 'programs', 'block', 'git push *'])).exit, 0)
    let policy = localCommandPolicyOf(await loadExecutorState(stateDir))
    assert.deepEqual([policy.allowlist, policy.denylist], [['npm *'], ['git push *']])
    assert.equal((await run(home, ['access', 'programs', 'mode', 'none'])).exit, 0)
    assert.equal((await run(home, ['access', 'programs', 'default', 'codex', 'on'])).exit, 0)
    policy = localCommandPolicyOf(await loadExecutorState(stateDir))
    assert.deepEqual(policy.allowlist, [])
    assert.deepEqual(policy.trusted, { unlikeotherai: false, claudeCode: false, codex: true, t3Code: false })
    assert.equal((await run(home, ['access', 'programs', 'allow', 'git * status'])).exit, 2)

    const site = await run(home, ['access', 'websites', 'add', 'https://docs.example.com/guide', '--json'])
    assert.equal(site.exit, 0, site.err)
    assert.deepEqual(site.json(), ['https://docs.example.com'])
    assert.equal((await run(home, ['access', 'websites', 'add', 'http://plain.example.com'])).exit, 2)

    const extra = await ensureOwnerOnlyStateDirectory(join(home, 'extra'))
    assert.equal((await run(home, ['access', 'folders', 'add', extra, '--name', 'extra'])).exit, 0)
    assert.deepEqual((await loadExecutorState(stateDir)).workspaceFolders.map((folder) => folder.name).sort(), ['extra', 'work'])
    assert.equal((await run(home, ['access', 'folders', 'remove', 'extra'])).exit, 0)
    const last = await run(home, ['access', 'folders', 'remove', 'work', '--json'])
    assert.equal(last.exit, 1)
    assert.equal((last.json() as { error: { code: string } }).error.code, 'LAST_FOLDER')

    assert.equal((await run(home, ['access', 'coding-assistants', 'conversations', 'off'])).exit, 0)
    assert.equal(await existingSessionsEnabled(stateDir), false)
    // Describing a team resolves the executor's own entry, so this one runs the real command line.
    const shown = spawned(home, ['access', 'show', '--team', SALES])
    assert.equal(shown.status, 0, shown.stderr)
    assert.match(shown.stdout, /can use:\n {2}Folders +work \(/u)
    assert.match(shown.stdout, /Programs +Only these: Codex/u)
    assert.match(shown.stdout, /Websites +https:\/\/docs\.example\.com/u)
    assert.match(shown.stdout, /Coding assistants +can't read your Claude Code and Codex conversations/u)
  } finally { await rm(home, { force: true, recursive: true }) }
})

test('requests list every team\'s waiting programs and answer one by a short id', { skip, timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-cli-requests-'))
  try {
    const stateDir = await team(home, SALES, { teamName: 'Sales', organizationName: 'Acme' })
    await team(home, RESEARCH, { teamName: 'Research', organizationName: 'Acme' })
    const id = randomUUID()
    const now = Date.now()
    await openProgramRequestStore(stateDir).create({ id, program: 'docker', args: ['build', '.'],
      requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 90_000).toISOString() })
    const listed = await run(home, ['requests', '--json'])
    assert.equal(listed.exit, 0, listed.err)
    assert.deepEqual((listed.json() as Array<{ id: string; team: string; program: string }>)
      .map((row) => [row.id, row.team, row.program]), [[id, 'Sales · Acme', 'docker']])
    const table = await run(home, ['requests', 'list'])
    assert.match(table.out, new RegExp(`${id.slice(0, 8)}\\s+Sales · Acme\\s+An agent\\s+docker build \\.`, 'u'))
    const status = await run(home, ['status', '--json'])
    assert.equal((status.json() as { teams: Array<{ status: string }> }).teams.find(Boolean)?.status, 'needs_you')
    // Waiting for an answer is not the same as running: no daemon runs these teams.
    assert.match((await run(home, ['status'])).out, /^Nessie Computer \S+ — not connected/u)
    const denied = await run(home, ['requests', 'deny', id.slice(0, 8)])
    assert.equal(denied.exit, 0, denied.err)
    assert.equal(denied.out, 'docker was not allowed.\n')
    assert.equal(await openProgramRequestStore(stateDir).answer(id), 'deny')
    assert.equal((await run(home, ['requests', 'deny', 'ffffffff'])).exit, 1)
  } finally { await rm(home, { force: true, recursive: true }) }
})

test('--team takes an id, a label or a unique part of it; two teams need it', { skip, timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-cli-teams-'))
  try {
    await team(home, SALES, { teamName: 'Sales', organizationName: 'Acme' })
    await team(home, RESEARCH, { teamName: 'Sales', organizationName: 'Acme' })
    const twins = await run(home, ['teams', '--json'])
    assert.deepEqual((twins.json() as Array<{ label: string }>).map((row) => row.label),
      ['Sales · Acme (api.example.test)', 'Sales · Acme (api.example.test)'])
    assert.equal((await run(home, ['access', 'show'])).exit, 2)
    assert.equal((await run(home, ['access', 'show', '--team', 'Sales'])).exit, 2)
    const byId = await run(home, ['access', 'programs', 'show', '--team', RESEARCH])
    assert.equal(byId.exit, 0, byId.err)
    assert.match(byId.out, /^Sales · Acme \(api\.example\.test\) may start: Only these programs/u)
    const missing = await run(home, ['access', 'show', '--team', 'Finance', '--json'])
    assert.equal(missing.exit, 1)
    assert.equal((missing.json() as { error: { code: string } }).error.code, 'TEAM_NOT_FOUND')
  } finally { await rm(home, { force: true, recursive: true }) }
})

test('disconnect asks first, and with --yes removes the team\'s settings here', { skip, timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-cli-disconnect-'))
  try {
    const stateDir = await team(home, SALES, { teamName: 'Sales', organizationName: 'Acme' })
    assert.equal((await run(home, ['disconnect'])).exit, 2)
    assert.equal((await run(home, ['disconnect', '--team', 'Sales'])).exit, 2)
    // No service manager here: the team is one only this command line keeps.
    const removed = await run(home, ['disconnect', '--team', 'Sales', '--yes'], 'win32')
    assert.equal(removed.exit, 0, removed.err)
    assert.match(removed.out, /^Disconnected Sales · Acme/u)
    await assert.rejects(access(stateDir))
  } finally { await rm(home, { force: true, recursive: true }) }
})

test('plumbing verbs stay plumbing; the commands people type are routed here', () => {
  for (const args of [['describe', '--state-dir', '/s'], ['pause', '--state-dir', '/s'], ['connect', '--state-dir', '/s'],
    ['teams', '--state-root', '/s'], ['status', SALES], ['sync', '--executor', SALES, 'status'], ['serve', '--state-dir', '/s']]) {
    assert.equal(isUserCommand(args), false, args.join(' '))
  }
  for (const args of [[], ['--help'], ['--version'], ['status'], ['teams', '--json'], ['pause'], ['add'], ['connect', '--no-wait'],
    ['access', 'programs', 'show'], ['help', 'plumbing']]) {
    assert.equal(isUserCommand(args), true, args.join(' '))
  }
})
