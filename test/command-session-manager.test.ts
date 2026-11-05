import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import type { ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import { createExecutorCommandSessionManager } from '../src/command-session-manager.js'
import { createDeepTestSourceSnapshot } from '../src/deeptest-source-snapshot.js'
import type { GuestVmSession } from '../src/guest-vm-session.js'
import { stopSandboxWorkspace } from '../src/sandbox-workspace.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const runId = '00000000-0000-4000-8000-000000000451'
const exec = promisify(execFile)

const commandFor = (
  args: Record<string, unknown>,
  expected?: { commit: string; manifest_digest: string },
): ExecutorCommandEnvelope => ({
  argumentDigest: `sha256:${'0'.repeat(64)}` as never,
  bindingFence: '1',
  bindingId: '00000000-0000-4000-8000-000000000452' as never,
  capabilityRevision: 1,
  commandId: '00000000-0000-4000-8000-000000000453' as never,
  expiresAt: '2099-08-12T12:00:00.000Z',
  idempotencyKey: 'command-session-manager-test',
  operationKey: 'command.run',
  payload: { args, runId, ...(expected ? {
    expected_commit: expected.commit,
    expected_manifest_digest: expected.manifest_digest,
  } : {}) },
})

const createGitWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-command-git-workspace-'))
  await exec('git', ['init', '--quiet', workspaceRoot])
  await exec('git', ['-C', workspaceRoot, 'config', 'user.email', 'test@example.test'])
  await exec('git', ['-C', workspaceRoot, 'config', 'user.name', 'Nessie Test'])
  await writeFile(join(workspaceRoot, 'app.ts'), 'export const reviewed = true\n')
  await exec('git', ['-C', workspaceRoot, 'add', '.'])
  await exec('git', ['-C', workspaceRoot, 'commit', '--quiet', '-m', 'reviewed source'])
  return workspaceRoot
}

const matchesReviewedLease = async (
  lease: { workspace: string },
  command: ExecutorCommandEnvelope,
): Promise<boolean> => {
  const snapshot = await createDeepTestSourceSnapshot(lease.workspace, lease.workspace)
  return snapshot.working_tree_state === 'clean'
    && snapshot.commit === command.payload.expected_commit
    && snapshot.manifest_digest === command.payload.expected_manifest_digest
}

const commandGuest = (): GuestVmSession => ({
  actBrowser: async () => ({ status: 'acted' }),
  closed: new Promise<void>(() => {}),
  closeCodingSession: async () => {},
  inspectRuntime: async () => ({ browser: false, claude: false, codex: true, tmux: false }),
  launchCodingSession: async () => {},
  observeBrowser: async () => ({ accessibilityTree: [], targets: [] }),
  observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running' }),
  openBrowser: async () => {},
  runCommand: async () => ({ exitCode: 0, output: 'passed', success: true }),
  stop: async () => {},
})

const stateFor = (workspaceRoot: string) => ({
  apiBaseUrl: 'https://api.example.test',
  browserSandbox: {
    allowedOrigins: ['https://app.example.test'],
    guestInitrdBuilderPath: '/private/builder',
    guestRuntimeBundlePath: '/private/runtime',
    kernelPath: '/private/kernel',
    vmHelperPath: '/private/helper',
  },
  descriptor: {
    // `command.run` is refused before a guest exists unless the reviewed policy
    // names the command, so a fixture that starts one has to name it too.
    commandAllowlist: ['pnpm *'],
    limits: { maxCommandRuntimeSeconds: 20, maxResultBytes: 20_000, maxSessions: 1 },
    operationKeys: ['command.run', 'workspace.review', 'sandbox.stop'],
    profiles: ['workspace_sandbox'],
    revision: 1,
  },
  executorId: '00000000-0000-4000-8000-000000000454',
  machinePrivateKey: 'private',
  machinePublicKey: 'public',
  workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
})

test('a team denylist refuses a command before touching files or starting a guest', async () => {
  let started = false
  const manager = createExecutorCommandSessionManager('/unused', {
    ...stateFor('/unused'), commandPolicy: { mode: 'all', allowlist: [], denylist: ['pnpm install *'] },
  }, {
    startSession: async () => { started = true; throw new Error('Must not start a guest') },
  })
  assert.deepEqual(await manager.run(commandFor({ program: 'pnpm', args: ['install'] }), runId),
    { code: 'EXECUTOR_COMMAND_DENIED', success: false })
  assert.equal(started, false)
})

test('command session starts one no-egress COW guest and forwards an argv request without a shell', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-command-manager-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-command-workspace-'))
  let resolveClosed: (() => void) | undefined
  const requests: Array<Record<string, unknown>> = []
  const session: GuestVmSession = {
    actBrowser: async () => ({ status: 'acted' }),
    closed: new Promise<void>((resolve) => { resolveClosed = resolve }),
    closeCodingSession: async () => {},
    inspectRuntime: async () => ({ browser: false, claude: false, codex: true, tmux: false }),
    launchCodingSession: async () => {},
    observeBrowser: async () => ({ accessibilityTree: [], targets: [] }),
    observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running' }),
    openBrowser: async () => {},
    runCommand: async (request) => {
      requests.push(request)
      return { exitCode: 0, output: 'passed', success: true }
    },
    stop: async () => { resolveClosed?.() },
  }
  try {
    const manager = createExecutorCommandSessionManager(stateDir, stateFor(workspaceRoot), {
      startSession: async (input) => {
        assert.equal(input.egressPolicy, undefined)
        assert.equal(input.codexAuthProfilePath, undefined)
        assert.equal(input.lease.runId, runId)
        return session
      },
    })
    assert.deepEqual(
      await manager.run(commandFor({ args: ['test'], cwd: 'packages/runtime', program: 'pnpm' }), runId),
      { exitCode: 0, output: 'passed', success: true },
    )
    assert.deepEqual(requests, [{
      args: ['test'],
      cwd: 'packages/runtime',
      maxResultBytes: 8_192,
      program: 'pnpm',
      runtimeSeconds: 20,
    }])
    assert.deepEqual(
      await manager.run(commandFor({ args: ['-c', 'id'], program: 'sh' }), runId),
      { code: 'EXECUTOR_COMMAND_DENIED', success: false },
    )
    assert.equal(requests.length, 1)
    assert.equal(await manager.stop(runId), true)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('command session refuses a guest without the command runtime', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-command-runtime-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-command-runtime-workspace-'))
  let stopped = 0
  const session: GuestVmSession = {
    actBrowser: async () => ({ status: 'acted' }),
    closed: new Promise<void>(() => {}),
    closeCodingSession: async () => {},
    inspectRuntime: async () => ({ browser: false, claude: false, codex: false, tmux: false }),
    launchCodingSession: async () => {},
    observeBrowser: async () => ({ accessibilityTree: [], targets: [] }),
    observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running' }),
    openBrowser: async () => {},
    runCommand: async () => ({ exitCode: 0, output: '', success: true }),
    stop: async () => { stopped += 1 },
  }
  try {
    const manager = createExecutorCommandSessionManager(stateDir, stateFor(workspaceRoot), {
      startSession: async () => session,
    })
    assert.deepEqual(
      await manager.run(commandFor({ args: [], program: 'pnpm' }), runId),
      { code: 'EXECUTOR_COMMAND_UNAVAILABLE', success: false },
    )
    assert.equal(stopped, 1)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('command lease verification admits the real clean COW Git workspace before starting a guest', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-command-lease-verify-'))
  const workspaceRoot = await createGitWorkspace()
  let started = 0
  let leaseWorkspace: string | undefined
  try {
    const expected = await createDeepTestSourceSnapshot(workspaceRoot, workspaceRoot)
    const manager = createExecutorCommandSessionManager(stateDir, stateFor(workspaceRoot), {
      startSession: async (input) => { started += 1; leaseWorkspace = input.lease.workspace; return commandGuest() },
      verifyLease: matchesReviewedLease,
    })
    assert.deepEqual(
      await manager.run(commandFor({ args: [], program: 'pnpm' }, expected), runId),
      { exitCode: 0, output: 'passed', success: true },
    )
    assert.equal(started, 1)
    assert.notEqual(leaseWorkspace, workspaceRoot)
    const copiedSnapshot = await createDeepTestSourceSnapshot(leaseWorkspace!, leaseWorkspace!)
    assert.equal(copiedSnapshot.manifest_digest, expected.manifest_digest)
    await manager.stopAll()
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('command lease verification rejects a workspace changed after review before any guest starts', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-command-lease-mutation-'))
  const workspaceRoot = await createGitWorkspace()
  let started = 0
  let copiedSnapshotState: 'clean' | 'dirty' | undefined
  try {
    const expected = await createDeepTestSourceSnapshot(workspaceRoot, workspaceRoot)
    await writeFile(join(workspaceRoot, 'app.ts'), 'export const reviewed = false\n')
    const manager = createExecutorCommandSessionManager(stateDir, stateFor(workspaceRoot), {
      startSession: async () => { started += 1; return commandGuest() },
      verifyLease: async (lease, command) => {
        const snapshot = await createDeepTestSourceSnapshot(lease.workspace, lease.workspace)
        copiedSnapshotState = snapshot.working_tree_state
        return snapshot.working_tree_state === 'clean'
          && snapshot.commit === command.payload.expected_commit
          && snapshot.manifest_digest === command.payload.expected_manifest_digest
      },
    })
    assert.deepEqual(
      await manager.run(commandFor({ args: [], program: 'pnpm' }, expected), runId),
      { code: 'EXECUTOR_COMMAND_UNAVAILABLE', success: false },
    )
    assert.equal(copiedSnapshotState, 'dirty')
    assert.equal(started, 0)
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('cancelling command lease verification prevents guest startup and releases its COW lease', { skip: WINDOWS_STATE_HELPER_SKIP, timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-command-lease-cancel-'))
  const workspaceRoot = await createGitWorkspace()
  let releaseVerification: ((value: boolean) => void) | undefined
  let signalVerification: (() => void) | undefined
  let started = 0
  const verification = new Promise<boolean>((resolve) => { releaseVerification = resolve })
  const verificationStarted = new Promise<void>((resolve) => { signalVerification = resolve })
  try {
    const expected = await createDeepTestSourceSnapshot(workspaceRoot, workspaceRoot)
    const manager = createExecutorCommandSessionManager(stateDir, stateFor(workspaceRoot), {
      startSession: async () => { started += 1; return commandGuest() },
      verifyLease: async (lease, command) => {
        assert.equal(await matchesReviewedLease(lease, command), true)
        signalVerification?.()
        return await verification
      },
    })
    const opening = manager.run(commandFor({ args: [], program: 'pnpm' }, expected), runId)
    await verificationStarted
    const stopping = manager.stopAll()
    releaseVerification?.(true)
    await stopping
    assert.deepEqual(await opening, { code: 'EXECUTOR_COMMAND_UNAVAILABLE', success: false })
    assert.equal(started, 0)
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})
