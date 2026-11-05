import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import type { CommandRunner } from '../src/coding-session/agent-env.js'
import { agentFailureReason } from '../src/coding-session/agent-process.js'
import { spawnCodingSessionHost } from '../src/coding-session/host-spawn.js'
import {
  CODING_SESSION_UNIT_ENV,
  reachableUserManager,
  stopOwnUserUnit,
  systemdRunArguments,
} from '../src/coding-session/host-unit.js'
import {
  createCodingProcessControl,
  parsePsStartTime,
  powershellExchange,
  WINDOWS_KILL,
  type PsRunner,
} from '../src/coding-session/process-control.js'
import {
  runCodingSelfCheck, runsAsWindowsServiceAccount, runsUnderWindowsService,
} from '../src/coding-session/self-check.js'
import { codingSessionPaths } from '../src/coding-session/session-files.js'

/**
 * Containment per supervisor (coding-sessions.md §3): the Windows service
 * refusal, the Linux user unit a host runs in, and the Windows Job Object the
 * native helper holds an agent in. The unit and the service account are
 * decided by what a host can observe, so both are driven through injected
 * observations here and run on any machine; the Job Object needs the built
 * helper and Windows, and runs against the real binary.
 */

const SESSION = '0f0e0d0c-0b0a-4908-8706-050403020100'

const whoami = (sid: string): CommandRunner => async (file, args) => ({
  code: 0,
  missing: false,
  stdout: file.endsWith('whoami.exe') && args.join(' ') === '/user /fo csv /nh' ? `"nt service\\nessieexecutor","${sid}"\r\n` : '',
})

test('a Windows service account is refused before anything runs, whatever its marker says', async () => {
  for (const sid of ['S-1-5-80-2395452366-1486337013-1183271399-3001658651-1409393455', 'S-1-5-18', 'S-1-5-19', 'S-1-5-20']) {
    assert.equal(await runsAsWindowsServiceAccount(whoami(sid), { SystemRoot: 'C:\\Windows' }), true, sid)
    const ran: string[] = []
    const run: CommandRunner = async (file, args, options) => {
      ran.push(file)
      return whoami(sid)(file, args, options)
    }
    assert.deepEqual(await runCodingSelfCheck({
      agent: 'claude', config: { command: ['claude'], args: [], allowedTools: [], disallowedTools: [] },
      cwd: 'C:\\work', env: {}, platform: 'win32', received: { SystemRoot: 'C:\\Windows' }, run,
    }), { ok: false, reason: 'unsupported_supervisor' })
    assert.deepEqual(ran, ['C:\\Windows\\System32\\whoami.exe'], 'nothing but whoami ran, by its absolute path')
  }
  // The refusal a terminal meets too, which has no self-check: the marker alone, or the token.
  assert.equal(await runsUnderWindowsService({
    platform: 'win32', received: { NESSIE_EXECUTOR_SUPERVISOR: 'service' }, run: async () => { throw new Error('ran') },
  }), true, 'the marker is enough, and nothing runs')
  assert.equal(await runsUnderWindowsService({ platform: 'win32', received: { SystemRoot: 'C:\\Windows' }, run: whoami('S-1-5-18') }), true)
  assert.equal(await runsUnderWindowsService({
    platform: 'win32', received: {}, run: whoami('S-1-5-21-3981365695-3656378865-214511470-1001'),
  }), false)
  assert.equal(await runsUnderWindowsService({ platform: 'linux', received: { NESSIE_EXECUTOR_SUPERVISOR: 'service' } }), false)
  // A person's account, and an answer that cannot be read, are not refused here.
  assert.equal(await runsAsWindowsServiceAccount(whoami('S-1-5-21-3981365695-3656378865-214511470-1001')), false)
  assert.equal(await runsAsWindowsServiceAccount(async () => ({ code: 1, missing: false, stdout: '' })), false)
})

test('a Linux host reaches its user manager through the runtime directory the SDK stripped', () => {
  const both = new Set(['/run/user/1000/systemd/private', '/run/user/1000/bus'])
  assert.deepEqual(reachableUserManager({
    platform: 'linux', uid: 1000, environment: { PATH: '/usr/bin' }, exists: (path) => both.has(path),
  }), {
    environment: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
  })
  // A container, or WSL without systemd: no manager, so the host falls back to setsid.
  assert.equal(reachableUserManager({ platform: 'linux', uid: 1000, environment: {}, exists: () => false }), undefined)
  assert.equal(reachableUserManager({ platform: 'darwin', uid: 501, environment: {}, exists: () => true }), undefined)
  assert.equal(reachableUserManager({ platform: 'win32', environment: {}, exists: () => true }), undefined)
})

test('the transient unit carries the host\'s environment, its log, and the kill mode the plan names', () => {
  const args = systemdRunArguments({
    argv: ['/usr/bin/node', '/opt/nessie/nessie-executor.cjs', 'coding-session-host', '--config', '/s/c.json', '--session', SESSION],
    cwd: '/opt/nessie',
    environment: { NESSIE_EXECUTOR_PACKAGED_CLI: '1', NESSIE_CODING_SESSIONS_CONFIG_DIGEST: 'sha256:abc', [CODING_SESSION_UNIT_ENV]: 'forged' },
    hostLog: '/s/coding-sessions/sessions/x/host.log',
    unit: `nessie-coding-${SESSION}`,
  })
  assert.deepEqual(args.slice(0, 5), ['--user', '--collect', '--quiet', '--unit', `nessie-coding-${SESSION}`])
  for (const property of ['KillMode=control-group', 'TimeoutStopSec=10', 'WorkingDirectory=/opt/nessie',
    'StandardOutput=append:/s/coding-sessions/sessions/x/host.log']) {
    assert.equal(args[args.indexOf(property) - 1], '-p', property)
  }
  // Names only: systemd-run copies its own values, so none is readable in its /proc/<pid>/cmdline.
  assert.ok(args.includes('--setenv=NESSIE_EXECUTOR_PACKAGED_CLI'))
  assert.ok(args.includes('--setenv=NESSIE_CODING_SESSIONS_CONFIG_DIGEST'))
  assert.equal(args.some((arg) => arg.includes('sha256:abc')), false)
  assert.deepEqual(args.filter((arg) => arg.startsWith(`--setenv=${CODING_SESSION_UNIT_ENV}=`)), [
    `--setenv=${CODING_SESSION_UNIT_ENV}=nessie-coding-${SESSION}`,
  ], 'the unit name is the executor\'s, never one the environment brought')
  assert.deepEqual(args.slice(args.indexOf('--') + 1, args.indexOf('--') + 3), ['/usr/bin/node', '/opt/nessie/nessie-executor.cjs'])
})

test('a host starts in its unit when systemd-run takes it, and detached when it refuses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-coding-unit-'))
  try {
    const paths = codingSessionPaths(dir, SESSION)
    await mkdir(paths.dir, { recursive: true })
    const entry = join(dir, 'host-entry.mjs')
    await writeFile(entry, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(join(dir, 'ran'))}, 'yes')\n`)
    const calls: { file: string; args: string[] }[] = []
    const manager = { environment: { XDG_RUNTIME_DIR: '/run/user/1000' } }
    const input = { configPath: join(dir, 'c.json'), entry, paths, sessionId: SESSION }
    const ok = (stdout = '') => ({ status: 'ok' as const, stdout })
    // systemd names the unit's main process, which is the host: the bridge waits for it while it loads.
    assert.deepEqual(await spawnCodingSessionHost(input, {
      userManager: () => manager,
      runUnit: async (file, args) => { calls.push({ file, args }); return ok(file === 'systemd-run' ? '' : '4242\n') },
    }), { mode: 'unit', pid: 4242 })
    assert.equal(calls[0]?.file, 'systemd-run')
    const unitOf = (args: string[]): string => args[args.indexOf('--unit') + 1]!
    const first = unitOf(calls[0]!.args)
    assert.match(first, new RegExp(`^nessie-coding-${SESSION}-[0-9a-f]{8}$`, 'u'))
    assert.deepEqual(calls[1], {
      file: 'systemctl', args: ['--user', 'show', '--property=MainPID', '--value', `${first}.service`],
    })
    assert.ok(existsSync(paths.hostLog), 'the log exists owner-only before systemd opens it')
    assert.equal(existsSync(join(dir, 'ran')), false, 'a started unit is not also spawned')

    // A systemd-run that timed out may have started the unit: the unit is asked before a second host starts.
    const timedOut = (mainPid: string) => async (file: string, args: string[]) => {
      calls.push({ file, args })
      return file === 'systemd-run' ? { status: 'timeout' as const, stdout: '' } : ok(mainPid)
    }
    assert.deepEqual(await spawnCodingSessionHost(input, { userManager: () => manager, runUnit: timedOut('4243\n') }),
      { mode: 'unit', pid: 4243 })
    assert.equal(existsSync(join(dir, 'ran')), false)
    // Each start names a unit of its own: the last host's, not yet collected, can never refuse the next.
    const second = unitOf(calls[2]!.args)
    assert.notEqual(second, first)
    assert.deepEqual(calls[3]!.args.at(-1), `${second}.service`)

    const ran = async (): Promise<string> => {
      const deadline = Date.now() + 20_000
      while (!existsSync(join(dir, 'ran')) && Date.now() < deadline) await new Promise((settle) => { setTimeout(settle, 100) })
      const text = await readFile(join(dir, 'ran'), 'utf8')
      await rm(join(dir, 'ran'))
      return text
    }
    const refused = await spawnCodingSessionHost(input, {
      userManager: () => manager, runUnit: async () => ({ status: 'failed', stdout: '' }),
    })
    assert.equal(refused.mode, 'detached')
    assert.equal(typeof refused.pid, 'number', 'a detached host is known by its pid')
    assert.equal(await ran(), 'yes', 'the refused unit fell back to a detached host')
    assert.match(await readFile(paths.hostLog, 'utf8'), /systemd-run refused the unit; starting the host detached/u)
    // Timed out, and no main process: no unit is running, so the host starts detached.
    assert.equal((await spawnCodingSessionHost(input, { userManager: () => manager, runUnit: timedOut('0\n') })).mode, 'detached')
    assert.equal(await ran(), 'yes')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('a closing host stops only its own unit, and only when it has one', async () => {
  const calls: string[][] = []
  const run = async (_file: string, args: string[]) => { calls.push(args); return { status: 'ok' as const, stdout: '' } }
  assert.equal(await stopOwnUserUnit({}, run), false)
  assert.equal(await stopOwnUserUnit({ [CODING_SESSION_UNIT_ENV]: 'sshd' }, run), false)
  // Only a name a bridge mints: the session's id and the start's own suffix.
  assert.equal(await stopOwnUserUnit({ [CODING_SESSION_UNIT_ENV]: `nessie-coding-${SESSION}` }, run), false)
  assert.deepEqual(calls, [])
  if (process.platform === 'linux') {
    const unit = `nessie-coding-${SESSION}-0a1b2c3d`
    const stopped = await stopOwnUserUnit({ [CODING_SESSION_UNIT_ENV]: unit }, run)
    if (stopped) assert.deepEqual(calls[0], ['--user', 'stop', '--no-block', `${unit}.service`])
  }
})

test('the job helper\'s own refusals read as categorical failure reasons', () => {
  assert.equal(agentFailureReason(['{"code":"EXECUTOR_JOB_SPAWN_FAILED","status":"rejected"}']), 'agent_missing')
  assert.equal(agentFailureReason(['{"code":"EXECUTOR_JOB_CONTAINMENT_FAILED","status":"rejected"}']), 'containment_failed')
  assert.equal(agentFailureReason(['{"code":"EXECUTOR_JOB_PARENT_GONE","status":"rejected"}']), 'containment_failed')
})

/** A parent that starts two sleeping children and prints their pids: a tree to kill, or to leave alone. */
const PARENT_WITH_CHILDREN = `
const { spawn } = require('node:child_process')
const kids = [0, 1].map(() => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true }))
console.log(kids.map((kid) => kid.pid).join(' '))
setTimeout(() => {}, 600000)
`

test('a recorded pid that now names somebody else is never signalled, nor is anything under it', { timeout: 90_000 }, async () => {
  // No job helper here: this is the tree walk every OS falls back on.
  const control = createCodingProcessControl(process.platform, {})
  const parent = control.spawnAgent(process.execPath, ['-e', PARENT_WITH_CHILDREN], { cwd: tmpdir(), env: process.env })
  const kids = await new Promise<number[]>((settle) => {
    createInterface({ input: parent.stdout! }).once('line', (line) => settle(line.trim().split(' ').map(Number)))
  })
  const everyone = [parent.pid!, ...kids]
  try {
    const real = await control.identify(parent.pid!)
    assert.ok(real?.startedAt)
    // The process that held this pid before, as a crashed host recorded it.
    const reused = { pid: parent.pid!, startedAt: String(BigInt(real.startedAt) - 1n) }
    assert.deepEqual(await control.descendants(reused), [], 'no tree is read below a pid that is not the recorded process')
    await control.killTree(reused, await control.descendants(reused))
    await control.killTree({ pid: parent.pid! })
    const staleChild = { pid: kids[0]!, startedAt: '1' }
    await control.killTree(reused, [staleChild])
    await new Promise((settle) => { setTimeout(settle, 1_000) })
    assert.deepEqual(everyone.map(alive), [true, true, true], 'the reused pid, its children and a stale snapshot entry all survive')

    const tree = await control.descendants(real)
    // Windows adds each console child's conhost.exe, which is a descendant too.
    for (const kid of kids) assert.ok(tree.some((entry) => entry.pid === kid), 'the recorded process\'s own children, with start times')
    assert.ok(tree.every((entry) => entry.startedAt))
    await control.killTree(real, tree)
    const deadline = Date.now() + 15_000
    while (everyone.some(alive) && Date.now() < deadline) await new Promise((settle) => { setTimeout(settle, 100) })
    assert.deepEqual(everyone.map(alive), [false, false, false], 'the recorded process and its tree die')
  } finally {
    for (const pid of everyone) if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
})

/**
 * `ps` as the macOS control runs it, answered by this machine's own `/bin/ps`,
 * with the table reads `fail` names failing the way a `ps` that timed out
 * does, and the budget each table read was given.
 */
const standInPs = () => {
  let tableReads = 0
  const failing = new Set<number>()
  const budgets: number[] = []
  const ps: PsRunner = async (args, timeoutMs) => {
    if (args[0] === '-A') {
      tableReads += 1
      budgets.push(timeoutMs)
      if (failing.has(tableReads)) return undefined
    }
    return new Promise((settle) => {
      execFile('/bin/ps', args, { env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' }, timeout: timeoutMs }, (error, stdout) => {
        settle(error ? undefined : stdout)
      })
    })
  }
  return {
    ps,
    /** The budgets of the table reads from here on. */
    mark: () => budgets.length,
    budgets: (from: number) => budgets.slice(from),
    /** Fails the table reads `offsets` after the next one, which is offset 0. */
    fail: (...offsets: number[]) => { for (const offset of offsets) failing.add(tableReads + 1 + offset) },
  }
}

const posixWithPs = process.platform === 'win32' ? 'POSIX only' : !existsSync('/bin/ps') ? 'needs /bin/ps' : false

const firstLine = (child: ChildProcess): Promise<string> => new Promise((settle) => {
  createInterface({ input: child.stdout! }).once('line', (line) => settle(line.trim()))
})

/**
 * An agent whose child is in a session of its own and ignores SIGTERM: the
 * group's SIGKILL misses it, so only a SIGKILL of its own pid ends it. The
 * pid is printed once the child is listening.
 */
const STUBBORN_OUTSIDER = `
const { spawn } = require('node:child_process')
const outsider = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], {
  detached: true, stdio: ['ignore', 'pipe', 'ignore'],
})
outsider.stdout.once('data', () => { console.log(outsider.pid); outsider.stdout.destroy() })
setInterval(() => {}, 1000)
`

test('POSIX: a table read that fails in the grace neither ends it early nor spares a member outside the group', {
  skip: posixWithPs, timeout: 60_000,
}, async () => {
  const stand = standInPs()
  const control = createCodingProcessControl('darwin', { termGraceMs: 1_000, ps: stand.ps })
  const agent = control.spawnAgent(process.execPath, ['-e', STUBBORN_OUTSIDER], { cwd: tmpdir(), env: process.env })
  const outsider = Number(await firstLine(agent))
  const everyone = [agent.pid!, outsider]
  try {
    const identity = await control.identify(agent.pid!)
    assert.ok(identity?.startedAt)
    const tree = await control.descendants(identity)
    assert.ok(tree.some((entry) => entry.pid === outsider), 'the outsider is in the tree by its parent')
    // The read before the SIGTERM answers; the first one in the grace does not.
    const mark = stand.mark()
    stand.fail(1)
    await control.killTree(identity, tree)
    const deadline = Date.now() + 5_000
    while (everyone.some(alive) && Date.now() < deadline) await new Promise((settle) => { setTimeout(settle, 100) })
    assert.deepEqual(everyone.map(alive), [false, false], 'the outsider got its SIGKILL')
    const [before, ...grace] = stand.budgets(mark)
    assert.equal(before, 10_000)
    // A final table read can time out under load; the documented post-grace refresh then gets the full budget.
    const inGrace = grace.at(-1) === 10_000 ? grace.slice(0, -1) : grace
    assert.ok(inGrace.length > 0 && inGrace.every((budget) => budget <= 1_000), `bounded grace reads: ${grace}`)
  } finally {
    for (const pid of everyone) if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
})

test('POSIX: with no table at all after the grace, nothing unchecked is signalled, and the log says so', {
  skip: posixWithPs, timeout: 60_000,
}, async () => {
  const stand = standInPs()
  const logged: string[] = []
  const control = createCodingProcessControl('darwin', { termGraceMs: 1_000, ps: stand.ps, log: (line) => logged.push(line) })
  const agent = control.spawnAgent(process.execPath, ['-e', STUBBORN_OUTSIDER], { cwd: tmpdir(), env: process.env })
  const outsider = Number(await firstLine(agent))
  try {
    const identity = await control.identify(agent.pid!)
    assert.ok(identity?.startedAt)
    const mark = stand.mark()
    // Every read after the one before the SIGTERM fails, the fresh one the SIGKILL needs as well.
    stand.fail(...Array.from({ length: 200 }, (_, index) => index + 1))
    await control.killTree(identity)
    const budgets = stand.budgets(mark)
    assert.equal(budgets.at(-1), 10_000, 'a grace that ended on a failed read has one more, with the whole budget')
    assert.equal(logged.length, 1, 'containment that could not be finished is on record')
    assert.match(logged[0]!, new RegExp(`^no process table after the grace: SIGKILL skipped for pid ${agent.pid}'s group and tree`, 'u'))
    await new Promise((settle) => { setTimeout(settle, 500) })
    assert.equal(alive(agent.pid!), false, 'the agent died of its SIGTERM')
    assert.equal(alive(outsider), true, 'a pid no table could check is never sent a SIGKILL')
  } finally {
    for (const pid of [agent.pid!, outsider]) if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
})

/** A group leader whose child stays in its group and ignores SIGTERM; it exits on its first line of input. */
const LEADER_LEAVING_A_MEMBER = `
const { spawn } = require('node:child_process')
const member = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], {
  stdio: ['ignore', 'pipe', 'ignore'],
})
member.stdout.once('data', () => { console.log(member.pid); member.stdout.destroy() })
process.stdin.once('data', () => process.exit(0))
`

test('POSIX: an exited leader\'s group is not taken for gone on a failed read', { skip: posixWithPs, timeout: 60_000 }, async () => {
  const stand = standInPs()
  const control = createCodingProcessControl('darwin', { termGraceMs: 1_000, ps: stand.ps })
  const leader = control.spawnAgent(process.execPath, ['-e', LEADER_LEAVING_A_MEMBER], { cwd: tmpdir(), env: process.env })
  const member = Number(await firstLine(leader))
  try {
    const identity = await control.identify(leader.pid!)
    assert.ok(identity?.startedAt)
    const exited = new Promise((settle) => { leader.once('exit', settle) })
    leader.stdin!.write('go\n')
    await exited
    stand.fail(1)
    assert.equal(await control.killExitedGroup!(identity), true)
    const deadline = Date.now() + 5_000
    while (alive(member) && Date.now() < deadline) await new Promise((settle) => { setTimeout(settle, 100) })
    assert.equal(alive(member), false, 'the member got its SIGKILL')
  } finally {
    if (alive(member)) process.kill(member, 'SIGKILL')
  }
})

test('macOS start times read the same in any time zone', () => {
  assert.equal(parsePsStartTime('Tue Sep 23 10:00:00 2026'), String(Date.UTC(2026, 8, 23, 10) / 1_000))
  assert.equal(parsePsStartTime('Thu Oct  1 09:05:07 2026'), String(Date.UTC(2026, 9, 1, 9, 5, 7) / 1_000))
  assert.equal(parsePsStartTime('mar. 23 sept. 2026'), undefined)
})

test('a packaged Windows runtime without its job helper starts no agent', () => {
  assert.equal(createCodingProcessControl('win32', { packaged: true }).refusal, 'containment_failed')
  assert.equal(createCodingProcessControl('win32', { packaged: false }).refusal, undefined)
  assert.equal(createCodingProcessControl('win32', { packaged: true, jobHelper: 'C:\\n\\helper.exe' }).refusal, undefined)
})

const NATIVE = fileURLToPath(new URL('../native/target/', import.meta.url))
const builtHelper = ['release', 'debug']
  .map((profile) => join(NATIVE, profile, 'nessie-executor-native.exe'))
  .find((path) => existsSync(path))

/** An agent that starts a child, which starts a grandchild and exits: an orphan `taskkill /T` cannot find. */
const ORPHANING_AGENT = `
const { spawn } = require('node:child_process')
const middle = spawn(process.execPath, ['-e', \`
  const { spawn } = require('node:child_process')
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore', windowsHide: true })
  console.log(orphan.pid)
\`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
middle.stdout.on('data', (chunk) => process.stdout.write(chunk))
middle.on('exit', () => setTimeout(() => {}, 600000))
`

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('Windows: a kill\'s PowerShell has done the kill only once it says it handled every line it was sent', {
  skip: process.platform !== 'win32' ? 'Windows only' : false,
  timeout: 90_000,
}, async () => {
  const target = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true })
  try {
    const control = createCodingProcessControl('win32', {})
    const identity = await control.identify(target.pid!)
    assert.ok(identity?.startedAt)
    const kill = powershellExchange(WINDOWS_KILL, () => [`${identity.pid} ${identity.startedAt}`])
    assert.equal(await kill.done, true, 'the kill itself says so')
    const deadline = Date.now() + 10_000
    while (alive(target.pid!) && Date.now() < deadline) await new Promise((settle) => { setTimeout(settle, 100) })
    assert.equal(alive(target.pid!), false)
    assert.equal(await powershellExchange(WINDOWS_KILL, () => []).done, true, 'and so it does with nothing to kill')
    // Stand-ins that print their table and read the first of the two lines sent back, then stop.
    const answered = "'.'; [Console]::Out.Flush(); $null = [Console]::In.ReadLine()"
    const stopped = (rest: string): Promise<boolean> => powershellExchange(`${answered}; ${rest}`, () => ['1 1', '2 2']).done
    assert.equal(await stopped('Start-Sleep -Seconds 60'), false, 'ended by its budget partway through the list, as a slow kill under load is')
    assert.equal(await stopped('exit 0'), false, 'gone partway through, even with a clean exit code')
  } finally {
    target.kill()
  }
})

/** An agent with a detached child, which libuv's kill-on-close job does not end with it; the child's pid is printed. */
const AGENT_WITH_DETACHED_CHILD = `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore', windowsHide: true })
console.log(child.pid)
setInterval(() => {}, 1000)
`

test('Windows: a standby stopped after it killed the agent leaves its cold kill the members it saw', {
  skip: process.platform !== 'win32' ? 'Windows only' : false,
  timeout: 90_000,
}, async () => {
  // The standby as a slow kill under load leaves it: the table read, the first line sent back — the agent
  // itself — killed, and the PowerShell gone before the rest.
  const firstOnly = WINDOWS_KILL.replace('while ($null', 'if ($null').replace(/; '\.'$/u, '; exit 0')
  assert.ok(firstOnly.includes('if ($null') && firstOnly.endsWith('exit 0'), 'the stand-in is the real kill, cut short')
  const killOnCue = `if ($null -eq [Console]::In.ReadLine()) { exit }; ${firstOnly}`
  const control = createCodingProcessControl('win32', { killOnCue })
  const agent = spawn(process.execPath, ['-e', AGENT_WITH_DETACHED_CHILD], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const child = Number(await firstLine(agent))
  try {
    const identity = await control.identify(agent.pid!)
    assert.ok(identity?.startedAt)
    assert.ok((await control.descendants(identity)).some((entry) => entry.pid === child), 'the child is in the agent\'s tree')
    await control.standbyKill!(identity)()
    const everyone = [agent.pid!, child]
    const deadline = Date.now() + 10_000
    while (everyone.some(alive) && Date.now() < deadline) await new Promise((settle) => { setTimeout(settle, 100) })
    assert.deepEqual(everyone.map(alive), [false, false],
      'the cold kill reached the child, though the agent it would have walked down from was already gone')
  } finally {
    if (alive(child)) process.kill(child)
    agent.kill()
  }
})

test('Windows: killing the agent through its Job Object takes the orphaned grandchild too', {
  skip: process.platform !== 'win32' ? 'Windows only' : !builtHelper ? 'build executor/native first' : false,
  timeout: 60_000,
}, async () => {
  const control = createCodingProcessControl('win32', { jobHelper: builtHelper! })
  const agent = control.spawnAgent(process.execPath, ['-e', ORPHANING_AGENT], { cwd: tmpdir(), env: process.env })
  const orphan = await new Promise<number>((settle) => {
    createInterface({ input: agent.stdout! }).once('line', (line) => settle(Number(line.trim())))
  })
  try {
    assert.equal(alive(orphan), true)
    const identity = await control.identify(agent.pid!)
    assert.ok(identity?.startedAt, 'the helper is identified by its start time as well as its pid')
    await control.killTree(identity!, await control.descendants(identity!))
    const deadline = Date.now() + 10_000
    while (alive(orphan) && Date.now() < deadline) await new Promise((settle) => { setTimeout(settle, 100) })
    assert.equal(alive(orphan), false, 'the orphan died with the job')
  } finally {
    if (alive(orphan)) process.kill(orphan)
  }
})
