import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  codingProcessIsAlive, createCodingProcessControl, type CodingProcessControl,
} from '../src/coding-session/process-control.js'
import type { CodingProcessIdentity } from '../src/coding-session/types.js'
import { createExecutorMcpSessionManager } from '../src/mcp-session-manager.js'
import type { ExecutorLocalMcpServer } from '../src/mcp-servers.js'
import { createStartBackoff } from '../src/mcp-start-backoff.js'
import type { PersonalHostExecutionLease } from '../src/personal-inference-guard.js'
import { packagedNativeHelperPath } from '../src/state-security.js'

/**
 * A local app's admission — on packaged Windows a `managed-host-barrier`
 * process holding the service's host lease — ends on every path out of a
 * session: a start that times out, exits or throws, a crash, an idle close and
 * a stop. Minis's Kelpie, failing its handshake every two minutes, left one
 * barrier process behind each time (95 under 1.0.15). Each admission here is
 * a recorder; the process control proves a stop the way Windows does, only
 * for a tree born into a Job Object (`localAppLaunch`).
 */

const SCRIPT = fileURLToPath(new URL('./fixtures/scripted-mcp-server.mjs', import.meta.url))

const server = (mode: string, env: Record<string, string> = {}): ExecutorLocalMcpServer => ({
  command: [process.execPath, SCRIPT], env: { NESSIE_TEST_MCP_MODE: mode, ...env }, name: 'app',
})

type Recorder = {
  events: string[]
  identities: CodingProcessIdentity[]
  admit: () => Promise<PersonalHostExecutionLease>
}

const recorder = (options: { failBind?: boolean } = {}): Recorder => {
  const events: string[] = []
  const identities: CodingProcessIdentity[] = []
  return {
    events, identities,
    admit: async () => ({
      id: `lease-${events.length}`,
      bindExecution: async (identity) => {
        identities.push(identity)
        if (options.failBind && identity.startedAt) throw new Error('the guard refused the identity')
      },
      release: async () => { events.push('release') },
      abandon: async () => { events.push('abandon') },
    }),
  }
}

const gone = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!codingProcessIsAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/**
 * This host's own control, with Windows' rule for a proof: only a recorded
 * identity (pid and start time) born into a Job Object is proved stopped.
 */
const jobLike = (proves = true): CodingProcessControl => {
  const real = createCodingProcessControl()
  return {
    ...real,
    containment: 'windows_job',
    containedLaunch: (command, args) => ({ command, args: [...args] }),
    stopTree: async (identity) => {
      await real.killTree(identity).catch(() => undefined)
      if (!proves || identity.containment !== 'windows_job' || !identity.startedAt) return 'unknown'
      return await gone(identity.pid) ? 'stopped' : 'unknown'
    },
  }
}

const managerWith = (
  spec: ExecutorLocalMcpServer, admission: Recorder, control: CodingProcessControl,
  extra: Parameters<typeof createExecutorMcpSessionManager>[2] = {},
) => createExecutorMcpSessionManager([spec], { maxResultBytes: 65_536 }, {
  admit: admission.admit, processControl: control, log: () => undefined, startTimeoutMs: 1_500, ...extra,
})

const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('a start whose handshake times out releases its admission once the tree is proved stopped', async () => {
  const admission = recorder()
  const sessions = managerWith(server('ok', { NESSIE_TEST_MCP_INIT_DELAY_MS: '60000' }), admission, jobLike())
  try {
    assert.equal((await sessions.probe('app')).available, false)
    assert.deepEqual(admission.events, ['release'])
    assert.ok(admission.identities.every((identity) => identity.containment === 'windows_job'),
      'the identity is recorded with the containment it was born into')
    assert.ok(await gone(admission.identities[0]!.pid), 'the server is not left running')
  } finally { await sessions.stopAll() }
})

test('a start that exits, and one that throws after its spawn, release their admissions too', async () => {
  // Slow enough to exit after its start time is recorded: one exiting before is kept, as a coding agent's is.
  const exits: ExecutorLocalMcpServer = { name: 'app',
    command: [process.execPath, '-e', 'setTimeout(() => process.exit(3), 2500)'] }
  for (const [label, spec, admission] of [
    ['exits', exits, recorder()],
    ['throws', server('ok'), recorder({ failBind: true })],
  ] as const) {
    const sessions = managerWith(spec, admission, jobLike(), { startTimeoutMs: 8_000 })
    try {
      assert.equal((await sessions.probe('app')).available, false, label)
      assert.deepEqual(admission.events, ['release'], label)
    } finally { await sessions.stopAll() }
  }
})

test('a session that ends — idle, crashed or stopped — releases its admission', async () => {
  const idle = recorder()
  const idleSessions = managerWith(server('ok'), idle, jobLike(), { idleTimeoutMs: 100 })
  const crashed = recorder()
  const crashSessions = managerWith(server('die-on-call'), crashed, jobLike())
  const stopped = recorder()
  const stopSessions = managerWith(server('ok'), stopped, jobLike())
  try {
    assert.equal((await idleSessions.listTools('app')).success, true)
    await until(() => idle.events.length > 0, 'the idle close')
    assert.deepEqual(idle.events, ['release'])

    assert.equal((await crashSessions.callTool('app', 'echo', { value: 'x' })).success, false)
    await until(() => crashed.events.length > 0, 'the crash close')
    assert.deepEqual(crashed.events, ['release'])

    assert.equal((await stopSessions.listTools('app')).success, true)
    assert.deepEqual(stopped.events, [])
    await stopSessions.stopAll()
    assert.deepEqual(stopped.events, ['release'])
  } finally {
    await Promise.allSettled([idleSessions.stopAll(), crashSessions.stopAll(), stopSessions.stopAll()])
  }
})

test('a stop that cannot be proved keeps the admission but ends the barrier process holding it', async () => {
  const admission = recorder()
  const sessions = managerWith(server('ok', { NESSIE_TEST_MCP_INIT_DELAY_MS: '60000' }), admission, jobLike(false))
  try {
    await sessions.probe('app')
    assert.deepEqual(admission.events, ['abandon'], 'custody stays; no barrier process outlives the attempt')
  } finally { await sessions.stopAll().catch(() => undefined) }
})

test('a local app that keeps failing to start is retried later and later, and a start forgets it', async () => {
  let now = Date.parse('2026-11-09T10:00:00.000Z')
  const changes: unknown[] = []
  const backoff = createStartBackoff({ baseMs: 60_000, maxMs: 30 * 60_000, now: () => now,
    onChange: (failures) => changes.push(failures) })
  const waits: number[] = []
  for (let failure = 1; failure <= 9; failure += 1) {
    backoff.failed('kelpie', 'handshake_failed')
    const retryAt = backoff.snapshot()[0]?.retryAt
    waits.push(retryAt ? Date.parse(retryAt) - now : 0)
    now += waits.at(-1)!
  }
  assert.deepEqual(waits.map((wait) => wait / 60_000), [0, 0, 1, 2, 4, 8, 16, 30, 30])
  backoff.failed('kelpie', 'handshake_failed')
  assert.equal(backoff.waiting('kelpie'), 'handshake_failed')
  assert.deepEqual(backoff.snapshot()[0], { name: 'kelpie', failures: 10, reason: 'handshake_failed',
    retryAt: new Date(now + 30 * 60_000).toISOString() })
  now += 30 * 60_000
  assert.equal(backoff.waiting('kelpie'), undefined)
  backoff.started('kelpie')
  assert.deepEqual(backoff.snapshot(), [])
  assert.equal(changes.length, 11)
})

test('a waiting local app is not started at all, and says so in its start failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-mcp-backoff-'))
  const startLog = join(directory, 'starts.log')
  let now = Date.parse('2026-11-09T10:00:00.000Z')
  const admission = recorder()
  const sessions = managerWith(server('never-start', { NESSIE_TEST_MCP_START_LOG: startLog }), admission, jobLike(),
    { now: () => now, startBackoffMs: 60_000 })
  const starts = async () => (await readFile(startLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).length
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) await sessions.probe('app')
    assert.equal(await starts(), 3, 'the fourth probe waits instead of starting a process')
    assert.equal(admission.events.length, 3, 'nothing is admitted while it waits')
    assert.deepEqual(sessions.startFailures(), [{ name: 'app', failures: 3, reason: 'launch_failed',
      retryAt: new Date(now + 60_000).toISOString() }])
    now += 60_000
    await sessions.probe('app')
    assert.equal(await starts(), 4)
  } finally {
    await sessions.stopAll()
    await rm(directory, { force: true, recursive: true })
  }
})

const jobHelper = process.platform === 'win32' && existsSync(packagedNativeHelperPath())
  ? packagedNativeHelperPath() : undefined

test('on Windows a local app runs in the job helper\'s Job Object, so a failed start\'s admission is released',
  { skip: jobHelper ? false : 'Windows with the native job helper beside the running Node only' }, async () => {
    const admission = recorder()
    const control = createCodingProcessControl('win32', { jobHelper, packaged: false })
    const sessions = managerWith(server('ok', { NESSIE_TEST_MCP_INIT_DELAY_MS: '60000' }), admission, control,
      { startTimeoutMs: 5_000 })
    try {
      assert.equal((await sessions.probe('app')).available, false)
      assert.deepEqual(admission.events, ['release'])
      const ok = recorder()
      const working = managerWith(server('ok'), ok, control, { startTimeoutMs: 15_000 })
      assert.equal((await working.listTools('app')).success, true, 'stdio passes straight through the helper')
      await working.stopAll()
      assert.deepEqual(ok.events, ['release'])
    } finally { await sessions.stopAll() }
  })

test('on Windows a bare name finds its .cmd through PATHEXT, as Kelpie\'s npm shim is, and runs in the Job Object',
  { skip: jobHelper ? false : 'Windows with the native job helper beside the running Node only' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nessie-mcp-cmd-'))
    const shim = recorder()
    const control = createCodingProcessControl('win32', { jobHelper, packaged: false })
    const sessions = createExecutorMcpSessionManager([{ name: 'app', command: ['scripted-shim'],
      env: { NESSIE_TEST_MCP_MODE: 'ok', PATH: `${directory};${process.env.PATH ?? ''}` } }],
    { maxResultBytes: 65_536 }, { admit: shim.admit, processControl: control, log: () => undefined,
      startTimeoutMs: 15_000 })
    try {
      await writeFile(join(directory, 'scripted-shim.cmd'), `@"${process.execPath}" "${SCRIPT}" %*\r\n`)
      assert.equal((await sessions.listTools('app')).success, true)
      await sessions.stopAll()
      assert.deepEqual(shim.events, ['release'])
      assert.ok(shim.identities.every((identity) => identity.containment === 'windows_job'))
    } finally {
      await sessions.stopAll()
      await rm(directory, { force: true, recursive: true })
    }
  })
