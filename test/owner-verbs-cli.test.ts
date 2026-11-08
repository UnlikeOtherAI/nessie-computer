import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { executorLocalMcpServerNames, type ExecutorLocalMcpServer } from '../src/mcp-servers.js'
import { allProgramTrust } from '../src/program-trust.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { loadExecutorState, saveExecutorState } from '../src/state-store.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

/**
 * The verbs the apps call, run as the apps run them: the real CLI entry in a
 * child process. With --json, a failure is one JSON line on standard output
 * with a code the apps can key on, never a message they have to read.
 */

const skip = WINDOWS_STATE_HELPER_SKIP
const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))

const cli = (args: string[], input?: string): { status: number | null; stdout: string; stderr: string } => {
  const env = { ...process.env }
  delete env.NESSIE_EXECUTOR_PACKAGED_CLI
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], {
    encoding: 'utf8', env, ...(input === undefined ? {} : { input }), timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const failure = (result: ReturnType<typeof cli>): { code: string; message: string } => {
  assert.equal(result.status, 1, result.stderr)
  const parsed = JSON.parse(result.stdout) as { error: { code: string; message: string } }
  assert.equal(typeof parsed.error.message, 'string')
  return parsed.error
}

const team = async (mcpServers?: ExecutorLocalMcpServer[]) => {
  const stateDir = await ensureOwnerOnlyStateDirectory(await mkdtemp(join(tmpdir(), 'nessie-owner-verbs-')))
  const keys = generateKeyPairSync('ed25519')
  await saveExecutorState(stateDir, {
    ...(mcpServers ? { mcpServers } : {}),
    apiBaseUrl: 'https://api.example.test',
    commandPolicy: { mode: 'allowlist', allowlist: [], denylist: [], trusted: allProgramTrust() },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.list', 'file.read', ...(mcpServers ? ['mcp.tools', 'mcp.call'] : [])],
      profiles: ['workspace_sandbox'], revision: 1, workspaceFolders: ['workspace'],
      ...(mcpServers ? { mcpServers: executorLocalMcpServerNames(mcpServers) } : {}),
    },
    executorId: '00000000-0000-4000-8000-000000000f01',
    machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    machinePublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    workspaceFolders: [{ name: 'workspace', path: stateDir }],
  })
  return stateDir
}

test('with --json, each app verb fails with a stable code', { skip, timeout: 240_000 }, async () => {
  const stateDir = await team()
  try {
    const missing = join(stateDir, 'no-such-team')
    assert.equal(failure(cli(['pause', '--state-dir', missing, '--json'])).code, 'EXECUTOR_STATE_UNAVAILABLE')
    assert.equal(failure(cli(['program-request', 'answer', '--state-dir', stateDir, '--id', '../x',
      '--answer', 'once', '--json'])).code, 'PROGRAM_REQUEST_ID_INVALID')
    assert.equal(failure(cli(['program-request', 'answer', '--state-dir', stateDir,
      '--id', '00000000-0000-4000-8000-000000000f02', '--answer', 'deny', '--json'])).code, 'PROGRAM_REQUEST_NOT_WAITING')
    assert.equal(failure(cli(['audience', '--state-dir', stateDir, '--json'])).code, 'EXECUTOR_NOT_CONNECTED')
    // Without --json the same failure is a sentence on standard error, as every other verb's is.
    const plain = cli(['audience', '--state-dir', stateDir])
    assert.equal(plain.status, 1)
    assert.equal(plain.stdout, '')
    assert.match(plain.stderr, /not connected/u)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('configure passes websites through and keeps the built-in programs a proposal leaves out', {
  skip, timeout: 120_000,
}, async () => {
  const stateDir = await team()
  try {
    const proposal = (extra: Record<string, unknown>) => JSON.stringify({
      operationKeys: ['file.list', 'file.read'],
      workspaceFolders: [{ name: 'workspace', path: stateDir }],
      commandPolicy: { mode: 'allowlist', allowlist: ['git *'], denylist: [], ...extra },
      allowedOrigins: ['https://docs.example.com'],
    })
    const saved = cli(['configure', '--configuration-input-stdin', '--state-dir', stateDir], proposal({}))
    assert.equal(saved.status, 0, saved.stderr)
    let state = await loadExecutorState(stateDir)
    assert.deepEqual(state.commandPolicy, { mode: 'allowlist', allowlist: ['git *'], denylist: [], trusted: allProgramTrust() })
    assert.deepEqual(state.allowedOrigins, ['https://docs.example.com'])
    // Named, the built-in programs change like any other rule.
    const off = { unlikeotherai: false, claudeCode: false, codex: false, t3Code: false }
    assert.equal(cli(['configure', '--configuration-input-stdin', '--state-dir', stateDir],
      proposal({ trusted: off })).status, 0)
    state = await loadExecutorState(stateDir)
    assert.deepEqual(state.commandPolicy?.trusted, off)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('removing one local app keeps the environment of the others; a resend that would strip it is refused', {
  skip, timeout: 120_000,
}, async () => {
  const servers: ExecutorLocalMcpServer[] = [
    { name: 'alpha', command: [process.execPath, 'alpha.mjs'], env: { ALPHA_TOKEN: 'secret-a' } },
    { name: 'beta', command: [process.execPath, 'beta.mjs'], env: { BETA_TOKEN: 'secret-b' } },
  ]
  const stateDir = await team(servers)
  try {
    const base = { operationKeys: ['file.list', 'file.read', 'mcp.tools', 'mcp.call'],
      workspaceFolders: [{ name: 'workspace', path: stateDir }] }
    const removed = cli(['configure', '--configuration-input-stdin', '--state-dir', stateDir],
      JSON.stringify({ ...base, mcpServerRemovals: ['alpha'] }))
    assert.equal(removed.status, 0, removed.stderr)
    let state = await loadExecutorState(stateDir)
    assert.deepEqual(state.mcpServers, [servers[1]])
    // The list as describe shows it, sent back: beta has no env there, so the save is refused.
    const copied = cli(['configure', '--configuration-input-stdin', '--state-dir', stateDir],
      JSON.stringify({ ...base, mcpServers: [{ name: 'beta', command: servers[1]!.command }] }))
    assert.equal(copied.status, 1)
    assert.match(copied.stderr, /beta without its environment/u)
    state = await loadExecutorState(stateDir)
    assert.deepEqual(state.mcpServers, [servers[1]])
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
})
