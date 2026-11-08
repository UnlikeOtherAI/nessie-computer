import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import type { CliContext, HostRun } from '../src/cli-output.js'
import { runUserCli } from '../src/cli-user.js'
import { allProgramTrust } from '../src/program-trust.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { saveExecutorState } from '../src/state-store.js'
import { ServiceUnreachable, type ServiceAnswer, type ServiceRequest } from '../src/windows-service-control.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

/**
 * The commands reach a team the Windows background service runs the way the
 * Windows app does: every request goes to the service's control channel, here
 * a stand-in that answers as the service would and records what it was asked.
 */

const SALES = '00000000-0000-4000-8000-0000000000a1'
const PLANS = '00000000-0000-4000-8000-0000000000b1'
const OPS = '00000000-0000-4000-8000-0000000000c1'
const SERVER = 'https://api.example.test'
const REQUEST = '7f3a9c21-0000-4000-8000-000000000001'

type Row = {
  executorId: string; daemonStatus: string; paused: boolean; pendingProgramRequests: number
  failure?: { message: string }
}

/** A service with two teams: Sales' ChatGPT plan connection, and Ops, which it runs on its own. */
const fakeService = () => {
  const asked: ServiceRequest[] = []
  const rows: Row[] = [
    { executorId: PLANS, daemonStatus: 'running', paused: false, pendingProgramRequests: 0 },
    { executorId: OPS, daemonStatus: 'running', paused: false, pendingProgramRequests: 1 },
  ]
  const names: Record<string, { teamName: string; organizationName: string; apiBaseUrl: string }> = {
    [PLANS]: { teamName: 'Sales', organizationName: 'Acme', apiBaseUrl: SERVER },
    [OPS]: { teamName: 'Ops', organizationName: 'Acme', apiBaseUrl: SERVER },
  }
  let policy = { mode: 'allowlist', allowlist: [] as string[], denylist: [] as string[], trusted: allProgramTrust() }
  let folders = [{ name: 'work', path: 'C:\\Users\\person\\work' }]
  let requests = [{ id: REQUEST, program: 'docker', args: ['build', '.'], requestedAt: '2026-11-08T10:00:00.000Z',
    expiresAt: '2026-11-08T10:02:00.000Z' }]
  const description = () => ({ commandPolicy: policy, mcpPolicy: { mode: 'installed', disabled: [] }, localApps: [],
    existingCodingSessionsEnabled: false, sandbox: { browserConfigured: false },
    policy: { operations: ['file.list', 'file.read'] }, reach: { folders, allowedOrigins: [] } })
  const call = async (request: ServiceRequest): Promise<ServiceAnswer> => {
    asked.push(request)
    const id = request.executorId as string
    switch (request.command) {
      case 'status': return { status: 'ok', executors: rows }
      case 'pairingStatus': return { status: 'pairing', pairing: names[id] ?? {} }
      case 'describe': return { status: 'describe', description: description() }
      case 'configureInput': {
        const input = request.configurationInput as { commandPolicy?: typeof policy; workspaceFolders: typeof folders }
        policy = input.commandPolicy ?? policy
        folders = input.workspaceFolders
        return { status: 'ok', executors: rows }
      }
      case 'setPaused': {
        rows.find((row) => row.executorId === id)!.paused = request.paused as boolean
        return { status: 'ok', executors: rows }
      }
      case 'programRequests': return { status: 'programRequests', requests }
      case 'answerProgramRequest': {
        requests = requests.filter((entry) => entry.id !== request.id)
        return { status: 'programRequests', requests }
      }
      case 'remove': return { status: 'removed', signedOff: true }
      default: return { status: 'error', reason: 'The control request is malformed.' }
    }
  }
  return { call, asked }
}

const localTeam = async (home: string) => {
  const stateDir = await ensureOwnerOnlyStateDirectory(join(home, '.local', 'state', 'nessie-executor', SALES))
  const folder = await ensureOwnerOnlyStateDirectory(join(home, 'work'))
  const keys = generateKeyPairSync('ed25519')
  await saveExecutorState(stateDir, {
    apiBaseUrl: SERVER,
    commandPolicy: { mode: 'allowlist', allowlist: [], denylist: [], trusted: allProgramTrust() },
    descriptor: { limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.read'], profiles: ['workspace_sandbox'], revision: 1, workspaceFolders: ['work'] },
    executorId: SALES,
    machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    machinePublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    workspaceFolders: [{ name: 'work', path: folder }],
  })
}

const runner = (home: string, host: HostRun, platform: NodeJS.Platform = 'win32') => async (
  args: string[], service: (request: ServiceRequest) => Promise<ServiceAnswer>,
) => {
  let out = ''
  let err = ''
  const context: CliContext = { out: (text) => { out += text }, err: (text) => { err += text },
    stdin: Readable.from([]), interactive: false, ask: async () => '', platform, home, now: () => new Date('2026-11-08T10:00:30Z'),
    sleep: async () => undefined, run: host }
  const exit = await runUserCli(args, { context, service,
    nameLookup: async () => ({ teamName: 'Sales', organizationName: 'Acme', apiBaseUrl: SERVER }) })
  return { exit, out, err, json: () => JSON.parse(out) as unknown }
}

const noPrograms: HostRun = async () => ({ code: null, stdout: '', stderr: '' })

test('a service team is a team; a service connection for a team here is that team\'s ChatGPT plan connection',
  { skip: WINDOWS_STATE_HELPER_SKIP, timeout: 120_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'nessie-cli-service-'))
    try {
      await localTeam(home)
      const service = fakeService()
      const run = runner(home, noPrograms)
      const teams = await run(['teams', '--json'], service.call)
      assert.equal(teams.exit, 0, teams.err)
      const rows = teams.json() as Array<Record<string, unknown>>
      assert.deepEqual(rows.map(({ executorId, label, status, runBy, planConnectionId }) => (
        { executorId, label, status, runBy, planConnectionId })), [
        { executorId: SALES, label: 'Sales · Acme', status: 'not_connected', runBy: 'account', planConnectionId: PLANS },
        { executorId: OPS, label: 'Ops · Acme', status: 'needs_you', runBy: 'service', planConnectionId: undefined },
      ])
      const status = await run(['status'], service.call)
      assert.match(status.out, /Sales · Acme\s+Not connected[^\n]*\n {4}ChatGPT plan connection: Working/u)
      assert.match(status.out, /Needs you: An agent wants to run `docker build \.` \(Ops · Acme\)/u)
    } finally { await rm(home, { force: true, recursive: true }) }
  })

test('pause, access, requests and disconnect on a service team go to the service, as the Windows app sends them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-cli-service-ops-'))
  try {
    const service = fakeService()
    const elevated: Array<Record<string, string> | undefined> = []
    const run = runner(home, async (file, _args, options) => {
      if (file === 'powershell.exe') elevated.push(options?.env)
      return { code: 0, stdout: '', stderr: '' }
    })
    const paused = await run(['pause', '--team', 'Ops', '--json'], service.call)
    assert.equal(paused.exit, 0, paused.err)
    assert.deepEqual(service.asked.at(-1), { command: 'setPaused', executorId: OPS, paused: true })
    assert.deepEqual((paused.json() as Array<{ paused: boolean }>).map((row) => row.paused), [true])

    const allowed = await run(['access', 'programs', 'allow', 'npm', '--team', 'Ops'], service.call)
    assert.equal(allowed.exit, 0, allowed.err)
    assert.match(allowed.out, /^Was: Only these: Apps from UnlikeOtherAI, Claude Code, Codex, T3 Code\nNow: .*npm \*/u)
    const proposal = service.asked.find((request) => request.command === 'configureInput')
    assert.deepEqual(proposal?.configurationInput, { operationKeys: ['file.list', 'file.read'],
      workspaceFolders: [{ name: 'work', path: 'C:\\Users\\person\\work' }],
      commandPolicy: { mode: 'allowlist', allowlist: ['npm *'], denylist: [], trusted: allProgramTrust() } })
    assert.equal(elevated.length, 0, 'no folder changed, so Windows asks nothing')

    const added = await run(['access', 'folders', 'add', join(home, 'reports'), '--team', 'Ops'], service.call)
    assert.equal(added.exit, 0, added.err)
    assert.equal(elevated[0]?.NESSIE_COMPUTER_FOLDER, join(home, 'reports'), 'the service is given the new folder first')

    const listed = await run(['requests', '--team', 'Ops', '--json'], service.call)
    assert.deepEqual((listed.json() as Array<{ id: string; team: string }>).map((row) => [row.id, row.team]), [[REQUEST, 'Ops · Acme']])
    const always = await run(['requests', 'always', REQUEST.slice(0, 8)], service.call)
    assert.equal(always.exit, 0, always.err)
    assert.equal(always.out, 'docker is now always allowed for Ops · Acme.\n')
    assert.deepEqual(service.asked.at(-1), { command: 'answerProgramRequest', executorId: OPS, id: REQUEST, answer: 'always' })

    const documents = await run(['documents', '--team', 'Ops', '--json'], service.call)
    assert.equal(documents.exit, 1)
    assert.equal((documents.json() as { error: { code: string } }).error.code, 'DOCUMENTS_UNAVAILABLE')

    const removed = await run(['disconnect', '--team', 'Ops', '--yes'], service.call)
    assert.equal(removed.exit, 0, removed.err)
    assert.deepEqual(service.asked.at(-1), { command: 'remove', executorId: OPS })
    assert.match(removed.out, /^Disconnected Ops · Acme\. Nessie shows this computer as disconnected/u)
  } finally { await rm(home, { force: true, recursive: true }) }
})

test('a service that can\'t be reached is named on the Overview; one that never admitted this account is not', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-cli-service-down-'))
  try {
    const run = runner(home, noPrograms)
    const down = await run(['status'], async () => { throw new ServiceUnreachable('notRunning') })
    assert.equal(down.exit, 0, down.err)
    assert.match(down.out, /The Nessie Computer service isn't running\. .* Teams it runs aren't listed\./u)
    const strange = await run(['status'], async () => { throw new ServiceUnreachable('notTrusted') })
    assert.match(strange.out, /Something other than the Nessie Computer service answered/u)
    const other = await run(['status'], async () => { throw new ServiceUnreachable('notAdmitted') })
    assert.doesNotMatch(other.out, /service/u)
  } finally { await rm(home, { force: true, recursive: true }) }
})

/** Windows' `reg` over an in-memory HKEY_CURRENT_USER. */
const registry = () => {
  const values = new Map<string, string>()
  const host: HostRun = async (file, args) => {
    if (file !== 'reg.exe') return { code: null, stdout: '', stderr: '' }
    const [verb, key, , name] = args
    const where = `${key}\\${name}`
    if (verb === 'query') {
      const value = values.get(where)
      return value === undefined ? { code: 1, stdout: '', stderr: '' }
        : { code: 0, stdout: `\r\n${key}\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`, stderr: '' }
    }
    if (verb === 'add') values.set(where, args[args.indexOf('/d') + 1]!)
    if (verb === 'delete') values.delete(where)
    return { code: 0, stdout: '', stderr: '' }
  }
  return { values, host }
}

test('on Windows, login and auto-restart are the app\'s own Run value and restart setting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-cli-windows-settings-'))
  try {
    const { values, host } = registry()
    const run = runner(home, host)
    const service = async () => { throw new ServiceUnreachable('notInstalled') }
    assert.equal((await run(['settings', 'login'], service)).out, 'Open Nessie Computer when I log in: off\n')
    const on = await run(['settings', 'login', 'on', '--json'], service)
    assert.equal(on.exit, 0, on.err)
    assert.deepEqual(on.json(), { openAtLogin: true })
    const login = values.get('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\NessieExecutorTray')
    assert.match(login ?? '', /^".*nessie-executor-tray\.exe"$/u)
    assert.deepEqual((await run(['settings', 'login', 'off', '--json'], service)).json(), { openAtLogin: false })
    assert.equal(values.has('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\NessieExecutorTray'), false)

    assert.equal((await run(['settings', 'auto-restart'], service)).out, 'Restart a team if it stops: on\n')
    assert.equal((await run(['settings', 'auto-restart', 'off'], service)).out, 'Restart a team if it stops: off\n')
    assert.equal(values.get('HKCU\\Software\\UnlikeOtherAI\\Nessie Executor\\RestartStoppedConnections'), '0')
  } finally { await rm(home, { force: true, recursive: true }) }
})

test('on a Mac with the app, login runs the app\'s own login item and auto-restart is the app\'s setting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-cli-mac-settings-'))
  try {
    const app = join(home, 'Applications', 'Nessie Executor.app')
    await mkdir(join(app, 'Contents'), { recursive: true })
    await writeFile(join(app, 'Contents', 'Info.plist'), '<plist/>')
    const calls: string[][] = []
    let loginItem = false
    let restart: string | undefined
    const host: HostRun = async (file, args) => {
      calls.push([file, ...args])
      if (file === '/usr/bin/plutil' && args.at(-1)!.startsWith(home)) {
        return { code: 0, stdout: args[1] === 'CFBundleIdentifier' ? 'com.unlikeotherai.nessie.executor.menubar\n' : 'Nessie Executor\n', stderr: '' }
      }
      if (file === join(app, 'Contents', 'MacOS', 'Nessie Executor')) {
        if (args[1] !== 'status') loginItem = args[1] === 'on'
        return { code: 0, stdout: `{"enabled":${loginItem}}\n`, stderr: '' }
      }
      if (file === '/usr/bin/defaults') {
        if (args[0] === 'write') restart = args[3] === 'true' ? '1' : '0'
        return restart === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: `${restart}\n`, stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    }
    const run = runner(home, host, 'darwin')
    const service = async () => { throw new ServiceUnreachable('notInstalled') }
    assert.deepEqual((await run(['settings', 'login', 'on', '--json'], service)).json(), { openAtLogin: true })
    assert.ok(calls.some((call) => call.at(-2) === '--login-item' && call.at(-1) === 'on'))
    assert.equal((await run(['settings', 'auto-restart', 'off'], service)).out, 'Restart a team if it stops: off\n')
    assert.ok(calls.some((call) => call.join(' ') === '/usr/bin/defaults write com.unlikeotherai.nessie.executor.menubar '
      + 'RestartStoppedConnections -bool false'))
  } finally { await rm(home, { force: true, recursive: true }) }
})

test('the relay\'s answer is read strictly: unreachable reasons are named, anything unrecognised fails', async () => {
  const { decodeServiceAnswer, windowsServiceRelay } = await import('../src/windows-service-control.js')
  assert.deepEqual(decodeServiceAnswer('{"status":"ok","executors":[]}\n'), { status: 'ok', executors: [] })
  assert.throws(() => decodeServiceAnswer('{"status":"unreachable","reason":"notAdmitted"}\n'),
    (error: unknown) => error instanceof ServiceUnreachable && error.reason === 'notAdmitted')
  assert.throws(() => decodeServiceAnswer('{"status":"unreachable","reason":"invented"}\n'),
    (error: unknown) => error instanceof ServiceUnreachable && error.reason === 'failed')
  for (const text of ['{"status":"ok"}', 'not json\n', '[]\n', '{"executors":[]}\n']) {
    assert.throws(() => decodeServiceAnswer(text), text)
  }
  // Outside the installed Windows command line there is no service to ask.
  const sent: string[] = []
  const relay = windowsServiceRelay(async (_file, args, options) => {
    sent.push(`${args.join(' ')}:${options?.input ?? ''}`)
    return { code: 0, stdout: '{"status":"ok","executors":[]}\n', stderr: '' }
  }, 'linux')
  await assert.rejects(relay({ command: 'status' }), (error: unknown) => error instanceof ServiceUnreachable
    && error.reason === 'notInstalled')
  assert.deepEqual(sent, [])
})

test('a waiting code shows how long Nessie gave it and where to enter it', async () => {
  const { codeLines } = await import('../src/cli-pairing-words.js')
  const now = new Date('2026-11-08T10:00:00Z')
  assert.equal(codeLines('48219037', '2026-11-08T10:05:00Z', now),
    'Code: 4821 9037   (5 minutes)\nIn Nessie, open Computers, choose Add a computer and enter the code.\n')
  assert.equal(codeLines('48219037', '2026-11-08T10:00:50Z', now).split('\n')[0], 'Code: 4821 9037   (1 minute)')
  assert.equal(codeLines('48219037', undefined, now).split('\n')[0], 'Code: 4821 9037')
})
