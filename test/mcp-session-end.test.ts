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
import { packagedNativeHelperPath } from '../src/state-security.js'

/**
 * What a local app's start leaves running ends on every path out of its
 * session: a start that times out, exits or throws, a crash, an idle close and
 * a stop. An app started inside a Job Object (packaged Windows) has that job
 * ended; any other is ended by its transport, and nothing of it is recorded
 * anywhere: a ChatGPT plan signs in whether or not a local app ever ran.
 */

const SCRIPT = fileURLToPath(new URL('./fixtures/scripted-mcp-server.mjs', import.meta.url))

const server = (mode: string, env: Record<string, string> = {}): ExecutorLocalMcpServer => ({
  command: [process.execPath, SCRIPT], env: { NESSIE_TEST_MCP_MODE: mode, ...env }, name: 'app',
})

const gone = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!codingProcessIsAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** This host's own control, starting every app as a Job Object would hold it, and recording each stop. */
const jobLike = (): CodingProcessControl & { stops: CodingProcessIdentity[] } => {
  const real = createCodingProcessControl()
  const stops: CodingProcessIdentity[] = []
  return {
    ...real,
    stops,
    containment: 'windows_job',
    containedLaunch: (command, args) => ({ command, args: [...args] }),
    stopTree: async (identity) => {
      stops.push(identity)
      await real.killTree(identity).catch(() => undefined)
      return await gone(identity.pid) ? 'stopped' : 'unknown'
    },
  }
}

const managerWith = (
  spec: ExecutorLocalMcpServer, control: CodingProcessControl,
  extra: Parameters<typeof createExecutorMcpSessionManager>[2] = {},
) => createExecutorMcpSessionManager([spec], { maxResultBytes: 65_536 }, {
  processControl: control, log: () => undefined, startTimeoutMs: 1_500, ...extra,
})

const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('a start whose handshake times out leaves nothing running', async () => {
  const control = jobLike()
  const sessions = managerWith(server('ok', { NESSIE_TEST_MCP_INIT_DELAY_MS: '60000' }), control)
  try {
    assert.equal((await sessions.probe('app')).available, false)
    assert.equal(control.stops.length, 1)
    assert.equal(control.stops[0]!.containment, 'windows_job', 'the job it was born into is the one ended')
    assert.ok(await gone(control.stops[0]!.pid), 'the server is not left running')
  } finally { await sessions.stopAll() }
})

test('a session that ends — idle, crashed or stopped — ends what it started', async () => {
  const idle = jobLike()
  const idleSessions = managerWith(server('ok'), idle, { idleTimeoutMs: 100 })
  const crashed = jobLike()
  const crashSessions = managerWith(server('die-on-call'), crashed)
  const stopped = jobLike()
  const stopSessions = managerWith(server('ok'), stopped)
  try {
    assert.equal((await idleSessions.listTools('app')).success, true)
    await until(() => idle.stops.length > 0, 'the idle close')
    assert.equal(idle.stops.length, 1)

    assert.equal((await crashSessions.callTool('app', 'echo', { value: 'x' })).success, false)
    await until(() => crashed.stops.length > 0, 'the crash close')
    assert.equal(crashed.stops.length, 1)

    assert.equal((await stopSessions.listTools('app')).success, true)
    assert.equal(stopped.stops.length, 0, 'a live session is left alone')
    await stopSessions.stopAll()
    assert.equal(stopped.stops.length, 1)
    assert.ok(await gone(stopped.stops[0]!.pid))
  } finally {
    await Promise.allSettled([idleSessions.stopAll(), crashSessions.stopAll(), stopSessions.stopAll()])
  }
})

test('an app outside a Job Object is ended by its transport, and a session bridge keeps what it detached', async () => {
  const real = createCodingProcessControl()
  const stops: CodingProcessIdentity[] = []
  // No contained launch: how every host but packaged Windows starts a local app.
  const control: CodingProcessControl = { ...real, containedLaunch: undefined,
    stopTree: async (identity) => { stops.push(identity); return 'unknown' } }
  const sessions = managerWith(server('ok'), control, { startTimeoutMs: 15_000 })
  try {
    assert.equal((await sessions.listTools('app')).success, true)
    await sessions.stopAll()
    assert.deepEqual(stops, [], 'no tree is hunted down: detached session hosts must outlive their bridge')
  } finally { await sessions.stopAll() }
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
  const control = jobLike()
  const sessions = managerWith(server('never-start', { NESSIE_TEST_MCP_START_LOG: startLog }), control,
    { now: () => now, startBackoffMs: 60_000 })
  const starts = async () => (await readFile(startLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).length
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) await sessions.probe('app')
    assert.equal(await starts(), 3, 'the fourth probe waits instead of starting a process')
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

test('on Windows a local app runs in the job helper\'s Job Object, which ends with a failed start',
  { skip: jobHelper ? false : 'Windows with the native job helper beside the running Node only' }, async () => {
    const control = createCodingProcessControl('win32', { jobHelper, packaged: false })
    const sessions = managerWith(server('ok', { NESSIE_TEST_MCP_INIT_DELAY_MS: '60000' }), control,
      { startTimeoutMs: 5_000 })
    try {
      assert.equal((await sessions.probe('app')).available, false)
      const working = managerWith(server('ok'), control, { startTimeoutMs: 15_000 })
      assert.equal((await working.listTools('app')).success, true, 'stdio passes straight through the helper')
      await working.stopAll()
    } finally { await sessions.stopAll() }
  })

test('on Windows a bare name finds its .cmd through PATHEXT, as Kelpie\'s npm shim is, and runs in the Job Object',
  { skip: jobHelper ? false : 'Windows with the native job helper beside the running Node only' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nessie-mcp-cmd-'))
    const control = createCodingProcessControl('win32', { jobHelper, packaged: false })
    const sessions = createExecutorMcpSessionManager([{ name: 'app', command: ['scripted-shim'],
      env: { NESSIE_TEST_MCP_MODE: 'ok', PATH: `${directory};${process.env.PATH ?? ''}` } }],
    { maxResultBytes: 65_536 }, { processControl: control, log: () => undefined, startTimeoutMs: 15_000 })
    try {
      await writeFile(join(directory, 'scripted-shim.cmd'), `@"${process.execPath}" "${SCRIPT}" %*\r\n`)
      assert.equal((await sessions.listTools('app')).success, true)
      await sessions.stopAll()
    } finally {
      await sessions.stopAll()
      await rm(directory, { force: true, recursive: true })
    }
  })
