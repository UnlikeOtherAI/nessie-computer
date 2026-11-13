import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  AGENT_GUARD_COMMAND,
  createHostProcessControl,
  guardedProcessControl,
  type AgentGuardLaunch,
} from '../src/coding-session/agent-guard.js'
import { agentFailureReason, startAgentProcess } from '../src/coding-session/agent-process.js'
import { CODING_SESSION_UNIT_ENV, runsInOwnUserUnit } from '../src/coding-session/host-unit.js'
import { codingJobHelper, createCodingProcessControl, packagedJobHelper,
  type CodingProcessControl } from '../src/coding-session/process-control.js'
import { codingSessionPaths } from '../src/coding-session/session-files.js'
import { alive, createCodingHarness, waitUntil } from './coding-session-harness.js'

/**
 * The agent guard (`agent-guard.ts`): where neither a Job Object nor the
 * host's own systemd unit ends a dead host's agent, the host starts the agent
 * through `coding-session-agent-guard`, which kills the agent's tree when the
 * host's pipe closes. These run the real guard as a subprocess on every OS;
 * the last one kills a real bridge's host mid-turn, and on Linux with a user
 * manager it is that host's unit, not the guard, that proves it.
 */

const EXECUTOR_DIR = fileURLToPath(new URL('..', import.meta.url))
const EXECUTOR_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const GUARD_HOST = fileURLToPath(new URL('./fixtures/agent-guard-host.ts', import.meta.url))
const SESSION_UNIT = 'nessie-coding-0f0e0d0c-0b0a-4908-8706-050403020100-0a1b2c3d'

/** Kills a process the way a crash or `kill -9` does: `taskkill /F` on Windows, SIGKILL elsewhere. */
const hardKill = (pid: number): void => {
  if (process.platform !== 'win32') {
    process.kill(pid, 'SIGKILL')
    return
  }
  const taskkill = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  execFileSync(taskkill, ['/PID', String(pid), '/F'], { windowsHide: true, stdio: 'ignore' })
}

const lines = (stream: NodeJS.ReadableStream): string[] => {
  const seen: string[] = []
  createInterface({ input: stream }).on('line', (line) => seen.push(line))
  return seen
}

type Exit = { code: number | null; signal: NodeJS.Signals | null }

const exitOf = (child: ChildProcess): Promise<Exit> => new Promise((settle) => {
  if (child.exitCode !== null || child.signalCode !== null) settle({ code: child.exitCode, signal: child.signalCode })
  else child.once('exit', (code, signal) => settle({ code, signal }))
})

const guardLaunch = { argv: [process.execPath, '--import', 'tsx', EXECUTOR_ENTRY, AGENT_GUARD_COMMAND], cwd: EXECUTOR_DIR, env: process.env }

test('Windows source hosts use the fixed Debug Job helper without claiming installed mode', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(packagedJobHelper({}), undefined)
  assert.ok(codingJobHelper({}), 'the source runner requires the built Debug helper')
  const control = createHostProcessControl(EXECUTOR_ENTRY, { environment: {} })
  assert.equal(control.containment, 'windows_job')
  assert.equal(control.identifySpawned, undefined, 'the real Job owns the launched tree')
})

test('a host starts its agent through the guard only where nothing else would end it', () => {
  const guarded = (control: CodingProcessControl): boolean => control.identifySpawned !== undefined
  assert.equal(guarded(createHostProcessControl('/opt/e/index.js', { platform: 'darwin', environment: {} })), true, 'macOS')
  assert.equal(guarded(createHostProcessControl('/opt/e/index.js', { platform: 'linux', environment: {}, inOwnUnit: false })), true,
    'Linux without a unit of its own')
  assert.equal(guarded(createHostProcessControl('/opt/e/index.js', { platform: 'linux', environment: {}, inOwnUnit: true })), false,
    'Linux in its unit: the cgroup ends the agent')
  assert.equal(guarded(createHostProcessControl('C:\\e\\index.ts', { platform: 'win32', environment: {}, jobHelper: undefined })), true,
    'a Windows development run')
  const packaged = { NESSIE_EXECUTOR_PACKAGED_CLI: '1' }
  assert.equal(guarded(createHostProcessControl('C:\\e\\nessie-executor.cjs', {
    platform: 'win32', environment: packaged, jobHelper: 'C:\\e\\nessie-executor-native.exe',
  })), false, 'packaged Windows: the Job Object ends the agent')
  const refused = createHostProcessControl('C:\\e\\nessie-executor.cjs', { platform: 'win32', environment: packaged, jobHelper: undefined })
  assert.deepEqual([refused.refusal, guarded(refused)], ['containment_failed', false], 'packaged without its helper starts nothing')

  // A unit counts only when the environment names one and the kernel puts this process in it.
  const inUnit = () => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${SESSION_UNIT}.service\n`
  assert.equal(runsInOwnUserUnit({ [CODING_SESSION_UNIT_ENV]: SESSION_UNIT }, inUnit), true)
  assert.equal(runsInOwnUserUnit({ [CODING_SESSION_UNIT_ENV]: SESSION_UNIT }, () => '0::/user.slice/nessie-executor.service\n'), false)
  assert.equal(runsInOwnUserUnit({ [CODING_SESSION_UNIT_ENV]: 'sshd' }, () => '0::/sshd.service\n'), false)
  assert.equal(runsInOwnUserUnit({}, inUnit), false)
  assert.equal(runsInOwnUserUnit({ [CODING_SESSION_UNIT_ENV]: SESSION_UNIT }, () => { throw new Error('no /proc') }), false)
})

/** An agent that prints its pid and two variables, echoes its input once it ends, and exits 7. */
const ECHO_AGENT = `
console.log(JSON.stringify({ pid: process.pid, value: process.env.GUARD_TEST_VALUE ?? null, channel: process.env.NODE_CHANNEL_FD ?? null }))
process.stderr.write('agent stderr\\n')
let text = ''
process.stdin.on('data', (chunk) => { text += chunk })
process.stdin.on('end', () => { console.log('read:' + text.trim()); process.exit(7) })
`

test('the guard is transparent: the agent\'s own identity, environment, output and exit code', { timeout: 60_000 }, async () => {
  const inner = createCodingProcessControl(process.platform, {})
  const control = guardedProcessControl(inner, guardLaunch)
  const guard = control.spawnAgent(process.execPath, ['-e', ECHO_AGENT], {
    cwd: tmpdir(), env: { ...process.env, GUARD_TEST_VALUE: 'from-the-host' },
  })
  const out = lines(guard.stdout!)
  const err = lines(guard.stderr!)
  const exited = exitOf(guard)
  const identity = await control.identifySpawned!(guard)
  assert.ok(identity?.startedAt, 'the guard reports a start time')
  const first = await waitUntil(async () => out[0], 20_000, 'the agent\'s first line')
  const reported = JSON.parse(first) as { pid: number; value: string | null; channel: string | null }
  assert.equal(identity.pid, reported.pid, 'the recorded identity is the agent\'s own pid')
  assert.notEqual(identity.pid, guard.pid, 'and never the guard\'s')
  assert.deepEqual(await inner.identify(identity.pid), identity, 'with the agent\'s own start time')
  assert.equal(reported.value, 'from-the-host', 'the host\'s environment for the agent reaches it over the pipe')
  assert.equal(reported.channel, null, 'the guard\'s own pipe does not')
  guard.stdin!.write('hello')
  control.endInput!(guard)
  assert.deepEqual(await exited, { code: 7, signal: null }, 'the guard exits with the agent\'s code')
  assert.deepEqual(out.slice(1), ['read:hello'])
  assert.ok(err.includes('agent stderr'))
})

test('a guard whose agent cannot start runs nothing and says so as the job helper does', { timeout: 60_000 }, async () => {
  const control = guardedProcessControl(createCodingProcessControl(process.platform, {}), guardLaunch)
  const guard = control.spawnAgent(join(tmpdir(), 'no-such-coding-agent'), [], { cwd: tmpdir(), env: process.env })
  const err = lines(guard.stderr!)
  const exited = exitOf(guard)
  assert.equal(await control.identifySpawned!(guard), undefined)
  assert.deepEqual(await exited, { code: 125, signal: null })
  await waitUntil(async () => (err.length > 0 ? true : undefined), 5_000, 'the refusal')
  assert.equal(agentFailureReason(err), 'agent_missing')
})

test('the guard refuses to run without a host holding its pipe', { timeout: 60_000 }, async () => {
  const guard = spawn(process.execPath, ['--import', 'tsx', EXECUTOR_ENTRY, AGENT_GUARD_COMMAND], {
    cwd: EXECUTOR_DIR, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  })
  const err = lines(guard.stderr!)
  assert.equal((await exitOf(guard)).code, 1)
  assert.match(err.join('\n'), /Usage: nessie-executor coding-session-agent-guard/u)
})

/** An agent that starts a grandchild outside its process group, prints its pid, and runs on. */
const FORKING_AGENT = `
const { spawn } = require('node:child_process')
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore', windowsHide: true })
grandchild.unref()
console.log(grandchild.pid)
setTimeout(() => {}, 600000)
`

test('when its host is killed the guard ends the agent and its grandchild within five seconds', { timeout: 90_000 }, async (t) => {
  const host = spawn(process.execPath, ['--import', 'tsx', GUARD_HOST, FORKING_AGENT], {
    cwd: EXECUTOR_DIR, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  })
  const out = lines(host.stdout!)
  const control = createCodingProcessControl(process.platform, {})
  const leftovers: { pid: number; startedAt?: string }[] = []
  try {
    const report = JSON.parse(await waitUntil(async () => out.find((line) => line.startsWith('{')), 30_000, 'the host\'s report')) as {
      guard: number; agent: { pid: number; startedAt: string }
    }
    const grandchild = Number(await waitUntil(async () => out.find((line) => /^\d+$/u.test(line)), 30_000, 'the grandchild'))
    const pids = [report.guard, report.agent.pid, grandchild]
    // By start time, so a failed run's cleanup below never signals a pid Windows has handed on.
    for (const pid of pids) leftovers.push(await control.identify(pid) ?? { pid })
    assert.deepEqual(pids.map(alive), [true, true, true])
    hardKill(host.pid!)
    const killedAt = Date.now()
    await waitUntil(async () => (pids.every((pid) => !alive(pid)) ? true : undefined), 5_000,
      'the guard, the agent and its grandchild to be gone')
    const elapsed = Date.now() - killedAt
    assert.ok(elapsed < 5_000)
    t.diagnostic(`gone ${elapsed} ms after the host was killed`)
  } finally {
    host.kill('SIGKILL')
    for (const identity of leftovers) await control.killTree(identity)
  }
})

test('a host killed mid-turn takes its agent and the agent\'s grandchild with it within five seconds', {
  timeout: 150_000,
}, async (t) => {
  const harness = await createCodingHarness()
  try {
    const answer = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: '#fork #hold=never a long refactor' })
    const sessionId = answer.body.sessionId as string
    await harness.waitForStatus(sessionId, (body) => body.status === 'working')
    const grandchild = await waitUntil(async () => {
      const name = (await readdir(harness.recordDir)).find((entry) => entry.startsWith('grandchild-'))
      return name ? Number(name.slice('grandchild-'.length, -'.pid'.length)) : undefined
    }, 30_000, 'the grandchild')
    const agent = (await harness.agents()).find((entry) => entry.event === 'start')!.pid as number
    const host = (JSON.parse(await readFile(join(harness.stateDir, 'sessions', sessionId, 'host.lock'), 'utf8')) as { pid: number }).pid
    assert.deepEqual([alive(host), alive(agent), alive(grandchild)], [true, true, true])
    // The guard where there is one; on Linux with a user manager, the host's own unit.
    hardKill(host)
    const killedAt = Date.now()
    await waitUntil(async () => (!alive(agent) && !alive(grandchild) ? true : undefined), 5_000,
      'the agent and its grandchild to die with their host')
    const elapsed = Date.now() - killedAt
    assert.ok(elapsed < 5_000)
    t.diagnostic(`gone ${elapsed} ms after the host was killed`)
  } finally {
    await harness.cleanup()
  }
})

const agentContext = async (dir: string, control: CodingProcessControl) => {
  const paths = codingSessionPaths(dir, randomUUID())
  await mkdir(paths.dir, { recursive: true })
  return { control, env: process.env, folder: tmpdir(), paths, log: () => undefined }
}

/** A guarded control that remembers each guard it started. */
type RecordingGuards = { control: CodingProcessControl; guards: ChildProcess[] }

const recordingGuards = (launch: AgentGuardLaunch = guardLaunch): RecordingGuards => {
  const guarded = guardedProcessControl(createCodingProcessControl(process.platform, {}), launch)
  const guards: ChildProcess[] = []
  return {
    guards,
    control: {
      ...guarded,
      spawnAgent: (command, args, options) => {
        const guard = guarded.spawnAgent(command, args, options)
        guards.push(guard)
        return guard
      },
    },
  }
}

const gone = (pids: number[], what: string, timeoutMs = 5_000): Promise<true> => (
  waitUntil(async () => (pids.every((pid) => !alive(pid)) ? true : undefined), timeoutMs, what)
)

/** Kills what a failed run left, each by its own start time. */
const cleanUp = async (pids: number[]): Promise<void> => {
  const control = createCodingProcessControl(process.platform, {})
  for (const pid of pids.filter(alive)) {
    const identity = await control.identify(pid)
    if (identity) await control.killTree(identity)
  }
}

test('a guard that ends while its host lives takes its agent with it before the host hears the agent exited', {
  timeout: 90_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-guard-orphan-'))
  const pids: number[] = []
  try {
    const { control, guards } = recordingGuards()
    const out: string[] = []
    const context = await agentContext(dir, control)
    const agent = await startAgentProcess(context, [process.execPath, '-e', FORKING_AGENT], (line) => out.push(line))
    const grandchild = Number(await waitUntil(async () => out.find((line) => /^\d+$/u.test(line)), 30_000, 'the grandchild'))
    pids.push(agent.identity.pid, grandchild)
    // Killed outright, the way the OOM killer ends it: the guard has no chance to act.
    hardKill(guards[0]!.pid!)
    await agent.exited
    // On POSIX the agent leads a group of its own and would run on; on Windows it is in the guard's
    // kill-on-close job and dies with it, while a grandchild of its own breaks away from that job.
    await gone([agent.identity.pid], 'the agent, once the host has heard it exited', 3_000)
    if (process.platform !== 'win32') await gone([grandchild], 'the agent\'s grandchild', 3_000)
  } finally {
    await cleanUp(pids)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

/** An agent that starts a grandchild outside its group and writes both pids to `GUARD_TEST_PIDS`, at once. */
const EARLY_FORKING_AGENT = `
const { spawn } = require('node:child_process')
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore', windowsHide: true })
grandchild.unref()
require('node:fs').writeFileSync(process.env.GUARD_TEST_PIDS, process.pid + ' ' + grandchild.pid)
setTimeout(() => {}, 600000)
`

test('a host gone before its guard reported still takes the agent\'s whole tree with it', { timeout: 90_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-guard-early-'))
  const pids: number[] = []
  try {
    const { control } = recordingGuards()
    const file = join(dir, 'pids')
    const guard = control.spawnAgent(process.execPath, ['-e', EARLY_FORKING_AGENT], {
      cwd: tmpdir(), env: { ...process.env, GUARD_TEST_PIDS: file },
    })
    let reported = false
    guard.on('message', () => { reported = true })
    const exited = exitOf(guard)
    const written = await waitUntil(async () => readFile(file, 'utf8').catch(() => undefined), 30_000, 'the agent\'s pids')
    pids.push(...written.split(' ').map(Number))
    // What the guard sees of a host that died: its pipe closing.
    guard.disconnect()
    // Where reading the agent's start time is slow (a PowerShell on Windows) this comes before the report.
    t.diagnostic(reported ? 'the guard had already reported the agent' : 'the guard had not yet reported the agent')
    await gone(pids, 'the agent and its grandchild')
    assert.equal((await exited).code, 1)
  } finally {
    await cleanUp(pids)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

/**
 * An agent with a child in its own process group and one in a session of its
 * own, which writes all three pids to `GUARD_TEST_PIDS` once both are started.
 */
const TWO_CHILD_AGENT = `
const { spawn } = require('node:child_process')
const member = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true })
const outsider = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore', windowsHide: true })
outsider.unref()
require('node:fs').writeFileSync(process.env.GUARD_TEST_PIDS, [process.pid, member.pid, outsider.pid].join(' '))
setTimeout(() => {}, 600000)
`

const UNIDENTIFIED_GUARD = fileURLToPath(new URL('./fixtures/agent-guard-unidentified.ts', import.meta.url))

/** `TWO_CHILD_AGENT` through a guard that cannot read its start time: the guard's exit, stderr and the pids. */
const unidentifiedAgent = async (dir: string, noTable: boolean) => {
  const file = join(dir, 'pids')
  const control = guardedProcessControl(createCodingProcessControl(process.platform, {}), {
    ...guardLaunch,
    argv: [process.execPath, '--import', 'tsx', UNIDENTIFIED_GUARD],
    env: { ...process.env, GUARD_TEST_PIDS: file, GUARD_TEST_NO_TABLE: noTable ? '1' : '0' },
  })
  const guard = control.spawnAgent(process.execPath, ['-e', TWO_CHILD_AGENT], {
    cwd: tmpdir(), env: { ...process.env, GUARD_TEST_PIDS: file },
  })
  const err = lines(guard.stderr!)
  guard.stdout!.resume()
  const exited = exitOf(guard)
  assert.equal(await control.identifySpawned!(guard), undefined, 'nothing is reported for an agent with no start time')
  const [agent, member, outsider] = (await readFile(file, 'utf8')).split(' ').map(Number) as [number, number, number]
  return { exit: await exited, err, agent, member, outsider }
}

test('an agent whose start time cannot be read is stopped with its whole tree, not by its pid alone', { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-guard-unidentified-'))
  const pids: number[] = []
  try {
    const run = await unidentifiedAgent(dir, false)
    pids.push(run.agent, run.member, run.outsider)
    assert.deepEqual(run.exit, { code: 125, signal: null })
    assert.equal(agentFailureReason(run.err), 'containment_failed')
    // Its tree by one table read, as a dead host's agent's is: the group it leads, and a child outside it.
    await gone(pids, 'the agent, its group and the child in a session of its own')
  } finally {
    await cleanUp(pids)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('POSIX: with no table for its tree either, an unidentified agent\'s group still goes with it', {
  skip: process.platform === 'win32' ? 'POSIX only: Windows has no process group' : false, timeout: 90_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-guard-no-table-'))
  const pids: number[] = []
  try {
    const run = await unidentifiedAgent(dir, true)
    pids.push(run.agent, run.member, run.outsider)
    assert.deepEqual(run.exit, { code: 125, signal: null })
    await gone([run.agent, run.member], 'the agent and the child in its group')
    // With no table, nothing identifies a process outside the group the guard started, so nothing signals it.
    assert.equal(alive(run.outsider), true, 'the child in a session of its own is not signalled unchecked')
  } finally {
    await cleanUp(pids)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('a guard that never reports is told to stop, then killed, and the start is not left waiting', { timeout: 60_000 }, async () => {
  // Stand-ins for a guard stuck before it reports: one that still hears its pipe close, one that does not.
  const stuck = (onDisconnect: string): AgentGuardLaunch => ({
    ...guardLaunch,
    argv: [process.execPath, '-e', `process.on('disconnect', () => { ${onDisconnect} }); setInterval(() => {}, 1000)`],
    reportTimeoutMs: 1_000,
    teardownMs: 2_000,
  })
  for (const [launch, ending] of [[stuck('process.exit(3)'), 'exits on its own'], [stuck(''), 'is killed']] as const) {
    const { control } = recordingGuards(launch)
    const guard = control.spawnAgent(process.execPath, ['-e', ''], { cwd: tmpdir(), env: process.env })
    const exited = exitOf(guard)
    const started = Date.now()
    assert.equal(await control.identifySpawned!(guard), undefined, ending)
    assert.ok(guard.exitCode !== null || guard.signalCode !== null, `a guard that ${ending} has exited before the host moves on`)
    assert.ok(Date.now() - started < 10_000)
    if (ending === 'exits on its own') assert.equal((await exited).code, 3)
  }
})

/**
 * The agent exits after three seconds, time enough for the guard to identify
 * it; its child, on the same stdout, keeps writing for three more, far longer
 * than a one-second drain. Detached, or on Windows it would be in the agent's
 * own kill-on-close job and die with it.
 */
const OUTLIVED_AGENT = `
const { spawn } = require('node:child_process')
const ticks = 'let n = 0; const t = setInterval(() => { console.log("tick " + ++n); if (n === 20) { console.log("last"); clearInterval(t) } }, 300)'
spawn(process.execPath, ['-e', ticks], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true }).unref()
console.log('agent done')
setTimeout(() => process.exit(0), 3_000)
`

test('the guard relays an agent\'s output to the end, however long a descendant holds its pipes', { timeout: 60_000 }, async () => {
  const control = guardedProcessControl(createCodingProcessControl(process.platform, {}), guardLaunch)
  const guard = control.spawnAgent(process.execPath, ['-e', OUTLIVED_AGENT], { cwd: tmpdir(), env: process.env })
  const out = lines(guard.stdout!)
  const exited = exitOf(guard)
  assert.ok(await control.identifySpawned!(guard))
  assert.deepEqual(await exited, { code: 0, signal: null })
  await waitUntil(async () => (out.includes('last') ? true : undefined), 5_000, 'the descendant\'s last line')
  assert.deepEqual([out[0], out.at(-1), out.length], ['agent done', 'last', 22])
})
