import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { executorServiceStateRoot, type ExecutorServiceEnvironment } from '../src/service-environment.js'
import { enableExecutorService } from '../src/service-linux.js'
import { macServicePlan } from '../src/service-macos.js'
import { runServiceRestartCli, WINDOWS_AUTORESTART } from '../src/service-restart-cli.js'
import { linuxRestartDropIn, serviceAutoRestartEnabled, setServiceAutoRestart } from '../src/service-restart.js'

/** The setting is owner-only JSON and the services are POSIX; both are staged only there. */
const POSIX_ONLY = process.platform === 'win32' ? 'launchd and systemd services use POSIX paths and ownership' : false

type Calls = { file: string; args: string[] }[]

const environment = (home: string, platform: NodeJS.Platform, calls: Calls, output: string[]) => ({
  confirm: async () => true, home, interactive: true,
  listStateDirectories: async () => ['team-one'],
  loadPairedState: async (stateDir: string) => { await mkdir(stateDir, { recursive: true, mode: 0o700 }) },
  platform,
  run: async (file: string, args: string[]) => { calls.push({ file, args }); return { code: 0, stdout: '' } },
  username: 'person', verifyPackagedRuntime: async () => undefined,
  write: (line: string) => output.push(line),
}) satisfies ExecutorServiceEnvironment

const withHome = async (body: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-restart-'))
  try { await body(home) } finally { await rm(home, { recursive: true, force: true }) }
}

test('autorestart names its own usage and is not the Windows CLI’s to change', async () => {
  const env = environment('/home/person', 'linux', [], [])
  assert.equal(await runServiceRestartCli(['status'], env), false)
  const misuses = [
    ['autorestart'], ['autorestart', '--yes'], ['autorestart', 'team-one', 'maybe'], ['autorestart', 'team-one', 'on', 'x'],
  ]
  const usage = /Usage: nessie-executor autorestart <executor-id> \[on\|off\]/
  for (const args of misuses) await assert.rejects(runServiceRestartCli(args, env), usage)
  await assert.rejects(runServiceRestartCli(['autorestart', 'team-one', 'off'], { ...env, platform: 'win32' }),
    (error: Error) => error.message === WINDOWS_AUTORESTART)
  await assert.rejects(runServiceRestartCli(['autorestart', '../escape', 'off'], env))
})

test('a team restarts on its own until someone turns that off', { skip: POSIX_ONLY }, async () => {
  await withHome(async (home) => {
    const stateDir = join(executorServiceStateRoot(home), 'team-one')
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    assert.equal(await serviceAutoRestartEnabled(stateDir), true)
    await setServiceAutoRestart(stateDir, false)
    assert.equal(await serviceAutoRestartEnabled(stateDir), false)
    await setServiceAutoRestart(stateDir, true)
    assert.equal(await serviceAutoRestartEnabled(stateDir), true)
  })
})

test('on Linux off writes a Restart=no drop-in and on removes it, each followed by a reload', { skip: POSIX_ONLY }, async () => {
  await withHome(async (home) => {
    const calls: Calls = []
    const output: string[] = []
    const env = environment(home, 'linux', calls, output)
    await runServiceRestartCli(['autorestart', 'team-one', 'off'], env)
    assert.equal(await readFile(linuxRestartDropIn(home, 'team-one'), 'utf8'), '[Service]\nRestart=no\n')
    await runServiceRestartCli(['autorestart', 'team-one'], env)
    await runServiceRestartCli(['autorestart', 'team-one', 'on'], env)
    await assert.rejects(readFile(linuxRestartDropIn(home, 'team-one')), { code: 'ENOENT' })
    assert.deepEqual(calls.map((call) => call.args.join(' ')), ['--user daemon-reload', '--user daemon-reload'])
    assert.deepEqual(output, [
      'executor team-one: autorestart=off', 'executor team-one: autorestart=off', 'executor team-one: autorestart=on',
    ])
  })
})

test('Linux enable writes the drop-in for a team whose restarting is off before it reloads', { skip: POSIX_ONLY }, async () => {
  await withHome(async (home) => {
    const calls: Calls = []
    const env = environment(home, 'linux', calls, [])
    const stateDir = join(executorServiceStateRoot(home), 'team-one')
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    await setServiceAutoRestart(stateDir, false)
    await enableExecutorService({ assumeYes: true, executorId: 'team-one' }, env)
    assert.equal(await readFile(linuxRestartDropIn(home, 'team-one'), 'utf8'), '[Service]\nRestart=no\n')
    assert.deepEqual(calls[0], { file: 'systemctl', args: ['--user', 'daemon-reload'] })
  })
})

test('on macOS a change re-registers the team’s agent, whose KeepAlive follows the setting', { skip: POSIX_ONLY }, async () => {
  await withHome(async (home) => {
    const reapplied: string[] = []
    const env = { ...environment(home, 'darwin', [], []), reapplyMacService: async (id: string) => { reapplied.push(id) } }
    await runServiceRestartCli(['autorestart', 'team-one', 'off'], env)
    assert.deepEqual(reapplied, ['team-one'])
    const mac = {
      ...env, launcher: '/opt/homebrew/opt/nessie-executor/bin/nessie-executor', searchPath: '/usr/bin', uid: 501,
    }
    assert.match(macServicePlan({ executorId: 'team-one', keepAlive: false }, mac).plist, /<key>KeepAlive<\/key><false\/>/)
    assert.match(macServicePlan({ executorId: 'team-one' }, mac).plist, /<key>KeepAlive<\/key><true\/>/)
  })
})
