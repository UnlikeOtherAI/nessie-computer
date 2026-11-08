import assert from 'node:assert/strict'
import test from 'node:test'

import {
  localCommandPolicyOf, localCommandPolicyPermits, localTerminalCommandRefusal, newLocalCommandPolicy,
  parseLocalCommandPolicy,
} from '../src/command-policy.js'
import { parseConfigurationInput } from '../src/configuration-input.js'

test('new connections allow commands; a denylist always wins', () => {
  const state = { descriptor: {}, commandPolicy: newLocalCommandPolicy() }
  assert.equal(localCommandPolicyPermits(state, 'git', ['status']), true)
  state.commandPolicy.denylist = ['git push *']
  assert.equal(localCommandPolicyPermits(state, 'git', ['push', '--force']), false)
  assert.equal(localCommandPolicyPermits(state, 'git', ['status']), true)
  state.commandPolicy.mode = 'allowlist'
  state.commandPolicy.allowlist = ['git *']
  assert.equal(localCommandPolicyPermits(state, 'git', ['push']), false)
  assert.equal(localCommandPolicyPermits(state, 'node', []), false)
})

test('legacy restrictions remain, an unset legacy list allows all, and team policies stay separate', () => {
  const legacy = { descriptor: { commandAllowlist: ['git status *'] } }
  assert.equal(localCommandPolicyPermits(legacy, 'git', ['push']), false)
  assert.equal(localCommandPolicyPermits({ descriptor: {} }, 'git', ['status']), true)
  assert.deepEqual(localCommandPolicyOf({ descriptor: { commandAllowlist: [] } }), newLocalCommandPolicy())
  const first = newLocalCommandPolicy()
  const second = newLocalCommandPolicy()
  first.denylist.push('git *')
  assert.deepEqual(second.denylist, [])
  const projected = localCommandPolicyOf(legacy)
  projected.allowlist.push('node *')
  assert.deepEqual(legacy.descriptor.commandAllowlist, ['git status *'])
})

test('local command input refuses malformed and ambiguous rules', () => {
  assert.throws(() => parseLocalCommandPolicy({ mode: 'all', allowlist: [], denylist: [], ignored: true }))
  assert.throws(() => parseLocalCommandPolicy({ mode: 'all', allowlist: [], denylist: ['*'] }))
  assert.throws(() => parseLocalCommandPolicy({ mode: 'allowlist', allowlist: ['git *', 'git  *'], denylist: [] }))
  assert.equal(localCommandPolicyPermits({ descriptor: {}, commandPolicy: newLocalCommandPolicy() }, '/bin/sh', []), false)
})

test('local configuration parses machine rules and preserves omitted settings', () => {
  const base = { operationKeys: ['file.read'], workspaceFolders: [{ name: 'work', path: '/work' }] }
  assert.equal(parseConfigurationInput(JSON.stringify(base)).commandPolicy, undefined)
  const policy = { mode: 'all', allowlist: [], denylist: ['git push *'] }
  assert.deepEqual(parseConfigurationInput(JSON.stringify({ ...base, commandPolicy: policy })).commandPolicy, policy)
  assert.throws(() => parseConfigurationInput(JSON.stringify({ ...base, commandPolicy: null })))
})

test('allow-all starts any terminal program, a shell or an absolute path included; denials still win', () => {
  const policy = { ...newLocalCommandPolicy(), denylist: ['git push *', 'rm *'] }
  for (const argv of [['bash', '-l'], ['/bin/zsh'], ['claude', '--model', 'opus'], ['/usr/local/bin/gemini']]) {
    assert.equal(localTerminalCommandRefusal(policy, argv, 'linux'), undefined, argv.join(' '))
  }
  assert.equal(localTerminalCommandRefusal(policy, ['git', 'push', 'origin'], 'linux'), 'denied')
  assert.equal(localTerminalCommandRefusal(policy, ['/usr/bin/git', 'push'], 'linux'), 'denied', 'a path does not hide a name')
  assert.equal(localTerminalCommandRefusal(policy, ['/opt/homebrew/bin/Git', 'push'], 'darwin'), 'denied', 'macOS finds Git as git')
  assert.equal(localTerminalCommandRefusal(policy, ['C:\\Program Files\\Git\\cmd\\GIT.EXE', 'push'], 'win32'), 'denied')
  assert.equal(localTerminalCommandRefusal({ ...policy, denylist: ['Git.exe push *'] }, ['git', 'push'], 'win32'), 'denied')
  assert.equal(localTerminalCommandRefusal(policy, ['git', 'status'], 'linux'), undefined)
  assert.equal(localTerminalCommandRefusal(policy, ['bin/claude'], 'linux'), 'invalid_program', 'relative paths depend on the folder')
  assert.equal(localTerminalCommandRefusal(policy, [''], 'linux'), 'invalid_program')
  assert.equal(localTerminalCommandRefusal(policy, [], 'linux'), 'invalid_program')
})

test('an allowlist starts only the named programs, found on PATH, never a shell or a path', () => {
  const policy = { mode: 'allowlist' as const, allowlist: ['claude *', 'git status *'], denylist: [] }
  assert.equal(localTerminalCommandRefusal(policy, ['claude'], 'linux'), undefined)
  assert.equal(localTerminalCommandRefusal(policy, ['claude', '--continue'], 'linux'), undefined)
  assert.equal(localTerminalCommandRefusal(policy, ['git', 'status', '-s'], 'linux'), undefined)
  assert.equal(localTerminalCommandRefusal(policy, ['git', 'push'], 'linux'), 'not_allowlisted')
  assert.equal(localTerminalCommandRefusal(policy, ['bash'], 'linux'), 'not_allowlisted')
  assert.equal(localTerminalCommandRefusal(policy, ['/tmp/checkout/claude'], 'linux'), 'path_needs_allow_all',
    'a permitted tool could leave an executable of that name anywhere')
  assert.equal(localTerminalCommandRefusal(policy, ['Claude.exe'], 'win32'), undefined)
})

test('configuration input carries the built-in programs, local apps policy and websites', () => {
  const base = { operationKeys: ['file.read'], workspaceFolders: [{ name: 'work', path: '/work' }] }
  const trusted = { unlikeotherai: true, claudeCode: false, codex: true, t3Code: false }
  const parsed = parseConfigurationInput(JSON.stringify({
    ...base,
    commandPolicy: { mode: 'allowlist', allowlist: [], denylist: [], trusted },
    mcpPolicy: { mode: 'installed', disabled: ['kelpie'] },
    allowedOrigins: ['https://b.example.test', 'https://a.example.test/'],
  }))
  assert.deepEqual(parsed.commandPolicy?.trusted, trusted)
  assert.deepEqual(parsed.mcpPolicy, { mode: 'installed', disabled: ['kelpie'] })
  assert.deepEqual(parsed.allowedOrigins, ['https://a.example.test', 'https://b.example.test'])
  assert.deepEqual(parseConfigurationInput(JSON.stringify({ ...base, allowedOrigins: [] })).allowedOrigins, [])
  const omitted = parseConfigurationInput(JSON.stringify(base))
  assert.equal(omitted.mcpPolicy, undefined)
  assert.equal(omitted.allowedOrigins, undefined)
  assert.throws(() => parseConfigurationInput(JSON.stringify({ ...base, allowedOrigins: ['http://a.example.test'] })),
    /HTTPS origin/)
  assert.throws(() => parseConfigurationInput(JSON.stringify({ ...base, allowedOrigins: 'https://a.example.test' })))
  assert.throws(() => parseConfigurationInput(JSON.stringify({ ...base, mcpPolicy: { mode: 'everything', disabled: [] } })))
  assert.throws(() => parseConfigurationInput(JSON.stringify({
    ...base, commandPolicy: { mode: 'allowlist', allowlist: [], denylist: [], trusted: { codex: true } },
  })))
})
