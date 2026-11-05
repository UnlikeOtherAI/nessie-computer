import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createMacServiceEnvironment, enableMacExecutorService, macServicePlan } from '../src/service-macos.js'

const POSIX_ONLY = process.platform === 'win32' ? 'launchd uses POSIX paths and ownership' : false
const environment = (home: string): ReturnType<typeof createMacServiceEnvironment> => ({
  confirm: async () => true, home, interactive: true,
  launcher: '/opt/homebrew/opt/nessie-executor/bin/nessie-executor',
  searchPath: '/opt/homebrew/bin:/usr/bin:/bin', uid: process.getuid?.() ?? 1000,
  listStateDirectories: async () => ['team-one'], loadPairedState: async () => undefined,
  platform: 'darwin', run: async () => ({ code: 1, stdout: '' }), username: 'person',
  verifyPackagedRuntime: async () => undefined, write: () => undefined,
})

test('Mac services isolate team state and quote launch arguments as XML, never a shell command', { skip: POSIX_ONLY }, () => {
  const env = environment('/Users/Person & Team')
  const one = macServicePlan({ executorId: 'team-one' }, env)
  const two = macServicePlan({ executorId: 'team-two' }, env)
  assert.notEqual(one.path, two.path)
  assert.notEqual(one.stateDir, two.stateDir)
  assert.match(one.plist, /Person &amp; Team/)
  assert.match(one.plist, /<key>PATH<\/key>/)
  assert.match(one.plist, /<key>ProgramArguments<\/key><array>/)
  assert.ok(one.plist.includes('<string>/opt/homebrew/opt/nessie-executor/libexec/runtime/nessie-executor-runtime</string>'))
  assert.doesNotMatch(one.plist, /<string>\/opt\/homebrew\/opt\/nessie-executor\/bin\/nessie-executor<\/string>/)
  assert.match(one.plist, /<key>NODE_OPTIONS<\/key><string><\/string>/)
  assert.throws(() => macServicePlan({ executorId: '../escape' }, env))
  assert.throws(() => macServicePlan({ executorId: 'team-one', stateDir: '/someone/else' }, env), /default state/)
  assert.throws(() => macServicePlan({ executorId: 'team-one' }, { ...env, launcher: '' }), /Homebrew/)
})

test('enable verifies pairing and runtime before registering an independent launch agent', { skip: POSIX_ONLY }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'nessie-launchd-'))
  try {
    const env = environment(home)
    const calls: string[] = []
    env.loadPairedState = async () => { calls.push('pairing') }
    env.verifyPackagedRuntime = async () => { calls.push('runtime') }
    env.run = async (file, args) => {
      assert.equal(file, '/bin/launchctl')
      calls.push(args[0]!)
      return { code: calls.length === 3 ? 1 : 0, stdout: '' }
    }
    await enableMacExecutorService({ executorId: 'team-one' }, env)
    assert.deepEqual(calls, ['pairing', 'runtime', 'print', 'enable', 'bootstrap', 'print'])
    const plan = macServicePlan({ executorId: 'team-one' }, env)
    assert.equal(await readFile(plan.path, 'utf8'), plan.plist)
    if (process.platform === 'darwin') await promisify(execFile)('/usr/bin/plutil', ['-lint', plan.path])
    const next = macServicePlan({ executorId: 'team-two' }, env)
    await symlink(plan.path, join(dirname(plan.path), next.label + '.plist'))
    await assert.rejects(enableMacExecutorService({ executorId: 'team-two' }, env), /ordinary file/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('failed runtime verification leaves launchd untouched', { skip: POSIX_ONLY }, async () => {
  const env = environment('/Users/person')
  env.verifyPackagedRuntime = async () => { throw new Error('runtime rejected') }
  env.run = async () => { assert.fail('launchd must not run') }
  await assert.rejects(enableMacExecutorService({ executorId: 'team-one' }, env), /runtime rejected/)
})
