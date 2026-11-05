import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalExecutorJson, type ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import { executeExecutorCommand } from '../src/daemon.js'
import { describeExecutor } from '../src/describe.js'
import { buildSignedDescriptor } from '../src/descriptor.js'
import { parseCommand } from '../src/cli-arguments.js'
import { configureExecutorLocalPolicy } from '../src/pair.js'
import { saveExecutorState } from '../src/state-store.js'
import type { ExecutorCommandSessionManager } from '../src/command-session-manager.js'
import type { ExecutorHost } from '../src/host-platform.js'
import type { ExecutorLocalState } from '../src/state-store.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const runId = '00000000-0000-4000-8000-000000000501'

const sandboxHost: ExecutorHost = {
  platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
  sandboxBackend: 'virtualization_framework',
  supervisor: 'service',
}

const commandFor = (args: Record<string, unknown>): ExecutorCommandEnvelope => {
  const payload = { args, runId }
  return {
    argumentDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}` as never,
    bindingFence: '1',
    bindingId: '00000000-0000-4000-8000-000000000502' as never,
    capabilityRevision: 1,
    commandId: '00000000-0000-4000-8000-000000000503' as never,
    expiresAt: '2099-08-12T12:00:00.000Z',
    idempotencyKey: 'command-allowlist',
    operationKey: 'command.run',
    payload,
  }
}

const stateWith = (commandAllowlist?: string[]): ExecutorLocalState => ({
  apiBaseUrl: 'https://api.example.test',
  browserSandbox: {
    allowedOrigins: ['https://app.example.test'],
    guestInitrdBuilderPath: '/private/builder',
    guestRuntimeBundlePath: '/private/runtime',
    kernelPath: '/private/kernel',
    vmHelperPath: '/private/helper',
  },
  descriptor: {
    ...(commandAllowlist ? { commandAllowlist } : {}),
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: ['command.run'],
    profiles: ['workspace_sandbox'],
    revision: 1,
  },
  executorId: '00000000-0000-4000-8000-000000000504',
  machinePrivateKey: 'private',
  machinePublicKey: 'public',
  workspaceFolders: [{ name: 'workspace', path: '/private/workspace' }],
})

const countingSessions = (): { calls: string[]; sessions: ExecutorCommandSessionManager } => {
  const calls: string[] = []
  const sessions = {
    run: async (command: ExecutorCommandEnvelope) => {
      calls.push((command.payload.args as { program: string }).program)
      return { exitCode: 0, output: 'done', success: true }
    },
  } as unknown as ExecutorCommandSessionManager
  return { calls, sessions }
}

test('a permitted command runs and an unlisted one never reaches a session', async () => {
  const { calls, sessions } = countingSessions()
  const state = stateWith(['git *', 'pnpm'])

  assert.deepEqual(
    await executeExecutorCommand('/private/state', state, commandFor({ args: ['status'], program: 'git' }), {
      commandSessions: sessions,
    }),
    { exitCode: 0, output: 'done', success: true },
  )
  assert.deepEqual(
    await executeExecutorCommand('/private/state', state, commandFor({ args: ['-la'], program: 'ls' }), {
      commandSessions: sessions,
    }),
    { code: 'EXECUTOR_COMMAND_DENIED', success: false },
  )
  // The refusal is the point: a program nobody named must not reach a backend
  // that could boot a guest for it.
  assert.deepEqual(calls, ['git'])
})

test('a wildcard widens an entry only to the right of what it names', async () => {
  const { calls, sessions } = countingSessions()
  // The case the user asked for: every script, but never `npm publish`.
  const state = stateWith(['npm run *', 'git status *', 'node'])
  const permits = async (program: string, args: string[]): Promise<boolean> => (
    (await executeExecutorCommand('/private/state', state, commandFor({ args, program }), {
      commandSessions: sessions,
    })).success === true
  )

  assert.equal(await permits('npm', ['run', 'build']), true)
  assert.equal(await permits('npm', ['run']), true)
  assert.equal(await permits('npm', ['publish']), false)
  assert.equal(await permits('npm', []), false)
  assert.equal(await permits('git', ['status', '--short']), true)
  assert.equal(await permits('git', ['push', '--force']), false)
  // Without a trailing wildcard an entry is exactly itself.
  assert.equal(await permits('node', []), true)
  assert.equal(await permits('node', ['--eval', 'process.exit(0)']), false)
  assert.deepEqual(calls, ['npm', 'npm', 'git', 'node'])
})

// Allow-all is every team's default: a policy that never named a program is
// not a restriction anyone chose, so it permits commands like a new pairing.
test('a policy that never named a program allows commands by default', async () => {
  const { calls, sessions } = countingSessions()

  assert.deepEqual(
    await executeExecutorCommand('/private/state', stateWith(), commandFor({ args: [], program: 'git' }), {
      commandSessions: sessions,
    }),
    { exitCode: 0, output: 'done', success: true },
  )
  assert.deepEqual(calls, ['git'])
})

test('the permitted programs are part of what a person reviews', () => {
  const key = generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'der', type: 'pkcs8' })
    .toString('base64url')
  const limits = { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 }
  const base = { limits, operationKeys: ['file.read'], profiles: ['workspace_sandbox'], revision: 2 }
  const withGit = buildSignedDescriptor(key, { ...base, commandAllowlist: ['git *'] }, sandboxHost)
  const withNode = buildSignedDescriptor(key, { ...base, commandAllowlist: ['git status *'] }, sandboxHost)
  const without = buildSignedDescriptor(key, base, sandboxHost)

  assert.deepEqual(withGit.descriptor.commandAllowlist, ['git *'])
  assert.equal(without.descriptor.commandAllowlist, undefined)
  // Swapping one permitted program for another is a different policy, so it
  // cannot reuse a digest a person already approved.
  assert.notEqual(withGit.descriptor.localPolicyDigest, withNode.descriptor.localPolicyDigest)
  assert.notEqual(withGit.descriptor.localPolicyDigest, without.descriptor.localPolicyDigest)
})

test('configure stores a canonical list and refuses command.run without one', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-allowlist-'))
  const state = stateWith()
  await saveExecutorState(stateDir, state)

  await assert.rejects(
    configureExecutorLocalPolicy(
      stateDir,
      state,
      ['file.read', 'command.run', 'workspace.review', 'sandbox.stop'],
      undefined,
      sandboxHost,
      state.workspaceFolders,
      [],
    ),
    /Name at least one permitted program/,
  )
  await assert.rejects(
    configureExecutorLocalPolicy(
      stateDir,
      state,
      ['file.read'],
      undefined,
      sandboxHost,
      state.workspaceFolders,
      ['/usr/bin/git'],
    ),
    /permitted command is a program/,
  )
  // A leading wildcard would permit the shells the program grammar refuses.
  await assert.rejects(
    configureExecutorLocalPolicy(
      stateDir, state, ['file.read'], undefined, sandboxHost, state.workspaceFolders, ['*'],
    ),
    /permitted command is a program/,
  )
  await assert.rejects(
    configureExecutorLocalPolicy(
      stateDir, state, ['file.read'], undefined, sandboxHost, state.workspaceFolders, ['sh *'],
    ),
    /permitted command is a program/,
  )
  // A wildcard in the middle would mean different things to different readers.
  await assert.rejects(
    configureExecutorLocalPolicy(
      stateDir, state, ['file.read'], undefined, sandboxHost, state.workspaceFolders, ['git * --force'],
    ),
    /permitted command is a program/,
  )
  await assert.rejects(
    configureExecutorLocalPolicy(
      stateDir,
      state,
      ['file.read'],
      undefined,
      sandboxHost,
      state.workspaceFolders,
      ['git *', 'git  *'],
    ),
    /listed once/,
  )

  const configured = await configureExecutorLocalPolicy(
    stateDir,
    state,
    ['file.read', 'command.run', 'workspace.review', 'sandbox.stop'],
    undefined,
    sandboxHost,
    state.workspaceFolders,
    ['pnpm  run   *', 'git *'],
  )
  // Hand-typed spacing is normalised, so the same policy typed twice is not two
  // revisions to review.
  assert.deepEqual(configured.commandPolicy?.allowlist, ['git *', 'pnpm run *'])
  assert.equal('commandAllowlist' in configured.descriptor, false)
  assert.equal(configured.descriptor.revision, 2)

  // Changing operations without saying anything about tools keeps the tools.
  const kept = await configureExecutorLocalPolicy(
    stateDir,
    configured,
    ['file.read', 'command.run', 'workspace.review', 'sandbox.stop'],
    undefined,
    sandboxHost,
    configured.workspaceFolders,
  )
  assert.deepEqual(kept.commandPolicy?.allowlist, ['git *', 'pnpm run *'])
  assert.equal('commandAllowlist' in kept.descriptor, false)

  // Clearing them leaves no key behind, so the next digest stays canonicalizable.
  const cleared = await configureExecutorLocalPolicy(
    stateDir,
    kept,
    ['file.read'],
    undefined,
    sandboxHost,
    kept.workspaceFolders,
    [],
  )
  assert.equal('commandAllowlist' in cleared.descriptor, false)
  const persisted = JSON.parse(await readFile(join(stateDir, 'executor-state.json'), 'utf8'))
  assert.equal('commandAllowlist' in persisted.descriptor, false)
})

/** `parseCommand` answers a union; only the configure arm carries an allowlist. */
const configureAllowlist = (args: string[]): string[] | undefined => {
  const parsed = parseCommand(args)
  assert.equal(parsed.kind, 'configure')
  return parsed.kind === 'configure' ? parsed.commandAllowlist : undefined
}

test('the CLI names permitted programs, clears them, or refuses to guess', () => {
  assert.deepEqual(
    parseCommand(['configure', '--state-dir', '/private/state', '--operations', 'file.read', '--tools', 'git *, pnpm run *']),
    {
      commandAllowlist: ['git *', 'pnpm run *'],
      kind: 'configure',
      operationKeys: ['file.read'],
      stateDir: '/private/state',
    },
  )
  assert.deepEqual(
    configureAllowlist(['configure', '--state-dir', '/private/state', '--operations', 'file.read', '--clear-tools']),
    [],
  )
  assert.equal(
    configureAllowlist(['configure', '--state-dir', '/private/state', '--operations', 'file.read']),
    undefined,
  )
  assert.throws(
    () => parseCommand([
      'configure',
      '--state-dir',
      '/private/state',
      '--operations',
      'file.read',
      '--tools',
      'git',
      '--clear-tools',
    ]),
    /Usage/,
  )
})

test('describe answers what this executor may reach and run, without its key', () => {
  const described = describeExecutor(stateWith(['git *', 'pnpm run *']))

  assert.deepEqual(described.policy.permittedPrograms, ['git *', 'pnpm run *'])
  assert.deepEqual(described.reach, {
    allowedOrigins: ['https://app.example.test'],
    folders: [{ name: 'workspace', path: '/private/workspace' }],
    guestSessions: 'available',
    // This state names no local MCP server, so it fronts none. The empty
    // array is the whole answer: `describe` is what the menu bar app renders,
    // and a missing key would leave it unable to say so.
    mcpServers: [],
  })
  assert.equal(described.sandbox.browserConfigured, true)
  assert.deepEqual(describeExecutor(stateWith()).policy.permittedPrograms, [])
  // The machine key is the one thing this projection must never carry, by
  // name or by value.
  assert.equal(JSON.stringify(described).includes('machinePrivateKey'), false)
  assert.equal(
    JSON.stringify(describeExecutor({
      ...stateWith(['git *']),
      machinePrivateKey: 'SECRET-MACHINE-KEY',
    })).includes('SECRET-MACHINE-KEY'),
    false,
  )
})
