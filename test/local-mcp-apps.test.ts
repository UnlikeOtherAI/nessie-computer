import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EXECUTOR_MCP_SERVER_MAXIMUM, EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS } from '@nessie/executor-protocol'

import { describeExecutor } from '../src/describe.js'
import type { DiscoveredLocalApp } from '../src/local-app-discovery.js'
import {
  composeLocalMcpServers, describeLocalApps, localAppsRevision, managedMcpOperations, refreshLocalApps,
} from '../src/local-mcp-apps.js'
import { listedLocalMcpPolicy, pairedLocalMcpPolicy, parseLocalMcpPolicy } from '../src/mcp-policy.js'
import { configureExecutorLocalPolicy } from '../src/pair.js'
import { loadExecutorState, saveExecutorState, type ExecutorLocalState } from '../src/state-store.js'
import type { ExecutorHost } from '../src/host-platform.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const host: ExecutorHost = {
  platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
  sandboxBackend: 'none',
  supervisor: 'service',
}

const app = (name: string, source: DiscoveredLocalApp['server']['source'], installed = true): DiscoveredLocalApp => ({
  installed, server: { name, command: [`/opt/${name}`, 'mcp'], source },
})

const kelpie = app('kelpie', 'unlikeotherai')
const chatterbox = app('chatterbox', 'claude-code')
const repl = app('node-repl', 'codex')

const paired = (overrides: Partial<ExecutorLocalState> = {}): ExecutorLocalState => ({
  apiBaseUrl: 'https://api.example.test',
  commandPolicy: { mode: 'allowlist', allowlist: [], denylist: [] },
  mcpPolicy: pairedLocalMcpPolicy(),
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: [...EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS],
    profiles: ['workspace_sandbox'],
    revision: 1,
    workspaceFolders: ['workspace'],
  },
  executorId: '00000000-0000-4000-8000-000000000704',
  machinePrivateKey: 'private',
  machinePublicKey: 'public',
  workspaceFolders: [{ name: 'workspace', path: '/private/workspace' }],
  ...overrides,
})

test('the local apps policy parses exactly', () => {
  assert.deepEqual(parseLocalMcpPolicy({ mode: 'installed', disabled: ['b', 'a'] }), { mode: 'installed', disabled: ['a', 'b'] })
  assert.throws(() => parseLocalMcpPolicy({ mode: 'all', disabled: [] }))
  assert.throws(() => parseLocalMcpPolicy({ mode: 'installed' }))
  assert.throws(() => parseLocalMcpPolicy({ mode: 'installed', disabled: ['Not A Name'] }))
  assert.throws(() => parseLocalMcpPolicy({ mode: 'installed', disabled: ['a', 'a'] }), /once/)
  assert.throws(() => parseLocalMcpPolicy({ mode: 'installed', disabled: [], extra: true }))
})

test('installed: every installed app except the switched-off ones, owner entries first, bridge last', () => {
  const owner = [
    { name: 'coding-sessions', command: ['/bridge'] },
    { name: 'chatterbox', command: ['/mine/chatterbox'] },
    { name: 'stale', command: ['/old'], source: 'codex' as const },
  ]
  const servers = composeLocalMcpServers(owner, [kelpie, chatterbox, repl, app('gone', 'codex', false)],
    { mode: 'installed', disabled: ['node-repl'] })
  assert.deepEqual(servers.map((server) => [server.name, server.source]), [
    ['chatterbox', undefined], ['kelpie', 'unlikeotherai'], ['coding-sessions', undefined],
  ])
  assert.deepEqual(composeLocalMcpServers(owner, [kelpie], listedLocalMcpPolicy()).map((server) => server.name),
    ['coding-sessions', 'chatterbox'], 'listed never adds a discovered app and drops stale ones')
})

test('the descriptor limit caps discovered apps, and the rest are reported as over it', () => {
  const many = Array.from({ length: EXECUTOR_MCP_SERVER_MAXIMUM + 2 }, (_, index) => app(`app-${index}`, 'codex'))
  const servers = composeLocalMcpServers([], many, pairedLocalMcpPolicy())
  assert.equal(servers.length, EXECUTOR_MCP_SERVER_MAXIMUM)
  const described = describeLocalApps(paired(), many)
  assert.deepEqual(described.filter((entry) => !entry.enabled).map((entry) => [entry.name, entry.reason]), [
    [`app-${EXECUTOR_MCP_SERVER_MAXIMUM}`, 'limit'], [`app-${EXECUTOR_MCP_SERVER_MAXIMUM + 1}`, 'limit'],
  ])
})

test('the MCP operations follow the apps under installed and stay the owner\'s under listed', () => {
  const base = ['file.read', 'mcp.tools']
  assert.deepEqual(managedMcpOperations(base, pairedLocalMcpPolicy(), 1), ['file.read', 'mcp.tools', 'mcp.call'])
  assert.deepEqual(managedMcpOperations(base, pairedLocalMcpPolicy(), 0), ['file.read'])
  assert.deepEqual(managedMcpOperations(['mcp.tools', 'mcp.call'], pairedLocalMcpPolicy(), 0), ['mcp.tools', 'mcp.call'],
    'never the descriptor\'s last operation')
  assert.deepEqual(managedMcpOperations(base, listedLocalMcpPolicy(), 0), base)
})

test('a change in the discovered set is a new revision; an unchanged one is not', () => {
  const state = paired()
  const first = localAppsRevision(state, [kelpie, chatterbox])!
  assert.equal(first.descriptor.revision, 2)
  assert.deepEqual(first.descriptor.mcpServers, ['chatterbox', 'kelpie'])
  assert.deepEqual(first.mcpServers?.map((server) => server.name), ['kelpie', 'chatterbox'])
  assert.deepEqual(first.descriptor.operationKeys.slice(-2), ['mcp.tools', 'mcp.call'])
  assert.equal(localAppsRevision(first, [kelpie, chatterbox]), undefined, 'the same apps are the same revision')
  const moved = localAppsRevision(first, [{ ...kelpie, server: { ...kelpie.server, command: ['/new/kelpie', 'mcp'] } }, chatterbox])
  assert.equal(moved?.descriptor.revision, 3, 'a moved program is a different launch spec')
  const removed = localAppsRevision(first, [])!
  assert.equal(removed.descriptor.revision, 3)
  assert.equal(removed.descriptor.mcpServers, undefined)
  assert.equal(removed.mcpServers, undefined)
  assert.deepEqual(removed.descriptor.operationKeys, [...EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS])
  const switchedOff = localAppsRevision({ ...first, mcpPolicy: { mode: 'installed', disabled: ['kelpie'] } },
    [kelpie, chatterbox])!
  assert.deepEqual(switchedOff.descriptor.mcpServers, ['chatterbox'])
  assert.equal(localAppsRevision(paired({ mcpPolicy: undefined }), [kelpie]), undefined,
    'an existing team keeps exactly the servers it named')
})

test('describe reports local apps, the policy, the built-in programs and websites without the browser', () => {
  const state = paired({
    mcpServers: [{ name: 'mine', command: ['/mine'] }, { ...kelpie.server }],
    mcpPolicy: { mode: 'installed', disabled: ['node-repl'] },
    allowedOrigins: ['https://example.test'],
    descriptor: { ...paired().descriptor, mcpServers: ['kelpie', 'mine'] },
  })
  const described = describeExecutor(state, { localApps: [kelpie, repl, app('absent', 'claude-code', false)], platform: 'linux' })
  assert.deepEqual(described.localApps, [
    { name: 'mine', source: 'configured', enabled: true, installed: true },
    { name: 'kelpie', source: 'unlikeotherai', enabled: true, installed: true },
    { name: 'node-repl', source: 'codex', enabled: false, installed: true, reason: 'switched_off' },
    { name: 'absent', source: 'claude-code', enabled: false, installed: false, reason: 'not_installed' },
  ])
  assert.deepEqual(described.mcpPolicy, { mode: 'installed', disabled: ['node-repl'] })
  assert.deepEqual(described.reach.allowedOrigins, ['https://example.test'])
  assert.equal(described.sandbox.browserConfigured, false)
  assert.deepEqual(described.reach.mcpServers.map((server) => [server.name, server.source]),
    [['kelpie', 'unlikeotherai'], ['mine', undefined]])
  assert.equal(described.programDefaults[0]?.available, false, 'no signature check on Linux')
  assert.deepEqual(describeExecutor(paired({ mcpPolicy: undefined })).mcpPolicy, listedLocalMcpPolicy())
  assert.deepEqual(describeExecutor(paired({ mcpPolicy: undefined }), { localApps: [kelpie] }).localApps,
    [{ name: 'kelpie', source: 'unlikeotherai', enabled: false, installed: true, reason: 'listed_only' }])
})

test('refresh saves a new revision through the compare-and-set writer', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-local-apps-'))
  try {
    const state = paired()
    await saveExecutorState(stateDir, state)
    const discovered = async () => [kelpie]
    const saved = await refreshLocalApps(stateDir, state, { readText: async () => undefined, env: { PATH: '' } })
    assert.equal(saved, undefined, 'nothing installed, nothing to change')
    const next = localAppsRevision(state, await discovered())!
    await saveExecutorState(stateDir, next, state)
    const loaded = await loadExecutorState(stateDir)
    assert.deepEqual(loaded.mcpServers, [{ ...kelpie.server }], 'the discovery source survives the state file')
    assert.deepEqual(loaded.mcpPolicy, pairedLocalMcpPolicy())
    await assert.rejects(saveExecutorState(stateDir, localAppsRevision(state, [chatterbox])!, state),
      /changed before this update/)
  } finally { await rm(stateDir, { force: true, recursive: true }) }
})

test('configure applies the local apps policy and websites, and No programs with command.run', {
  skip: WINDOWS_STATE_HELPER_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-configure-apps-'))
  try {
    const state = paired()
    await saveExecutorState(stateDir, state)
    const configured = await configureExecutorLocalPolicy(stateDir, state, ['file.read', 'mcp.tools', 'mcp.call'],
      undefined, host, undefined, undefined, undefined, {}, undefined, {
        mcpPolicy: { mode: 'installed', disabled: ['chatterbox'] },
        allowedOrigins: ['https://b.example.test', 'https://a.example.test/'],
        discover: async () => [kelpie, chatterbox],
      })
    assert.equal(configured.descriptor.revision, 2)
    assert.deepEqual(configured.descriptor.mcpServers, ['kelpie'])
    // A Mac's descriptor also offers imessage.send (src/imessage/imessage-operation.ts).
    assert.deepEqual(configured.descriptor.operationKeys, ['file.read', 'mcp.tools', 'mcp.call', 'imessage.send'])
    assert.deepEqual(configured.allowedOrigins, ['https://a.example.test', 'https://b.example.test'])
    assert.equal(configured.browserSandbox, undefined)
    assert.deepEqual(configured.mcpPolicy, { mode: 'installed', disabled: ['chatterbox'] })
    assert.deepEqual(await loadExecutorState(stateDir), configured)

    const none = await configureExecutorLocalPolicy(stateDir, configured, ['file.read'],
      undefined, host, undefined, undefined, undefined, {}, undefined, { discover: async () => [] })
    assert.deepEqual(none.descriptor.operationKeys, ['file.read', 'imessage.send'], 'no app, no MCP operations')
    assert.equal(none.descriptor.mcpServers, undefined)
    assert.deepEqual(none.allowedOrigins, configured.allowedOrigins, 'absent keeps the websites')

    const sandboxHost: ExecutorHost = { ...host, sandboxBackend: 'virtualization_framework' }
    const browser = {
      allowedOrigins: ['https://old.example.test'], guestInitrdBuilderPath: '/b', guestRuntimeBundlePath: '/r',
      kernelPath: '/k', vmHelperPath: '/h',
    }
    const withBrowser = { ...none, browserSandbox: browser }
    delete withBrowser.allowedOrigins
    await saveExecutorState(stateDir, withBrowser, none)
    const noPrograms = await configureExecutorLocalPolicy(stateDir, withBrowser,
      ['file.read', 'command.run', 'workspace.review', 'sandbox.stop'], undefined, sandboxHost, undefined, undefined,
      undefined, {}, { mode: 'allowlist', allowlist: [], denylist: [],
        trusted: { unlikeotherai: false, claudeCode: false, codex: false, t3Code: false } },
      { allowedOrigins: [], discover: async () => [] })
    assert.ok(noPrograms.descriptor.operationKeys.includes('command.run'), 'No programs is a policy, not an error')
    assert.deepEqual(noPrograms.browserSandbox?.allowedOrigins, [], 'websites live in the browser once it is set up')
    assert.equal(noPrograms.allowedOrigins, undefined)
  } finally { await rm(stateDir, { force: true, recursive: true }) }
})
