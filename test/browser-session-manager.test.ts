import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import type { ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import { createExecutorBrowserSessionManager } from '../src/browser-session-manager.js'
import { createDeepTestSourceSnapshot } from '../src/deeptest-source-snapshot.js'
import type { GuestVmSession } from '../src/guest-vm-session.js'
import { stopSandboxWorkspace } from '../src/sandbox-workspace.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const runId = '00000000-0000-4000-8000-000000000301'
const secondRunId = '00000000-0000-4000-8000-000000000306'
const exec = promisify(execFile)

const commandFor = (
  operationKey: 'browser.act' | 'browser.open' | 'browser.observe',
  args: Record<string, unknown>,
  commandRunId = runId,
  expected?: { commit: string; manifest_digest: string },
): ExecutorCommandEnvelope => ({
  argumentDigest: `sha256:${'0'.repeat(64)}` as never,
  bindingFence: '1',
  bindingId: '00000000-0000-4000-8000-000000000302' as never,
  capabilityRevision: 1,
  commandId: operationKey === 'browser.open'
    ? '00000000-0000-4000-8000-000000000303' as never
    : '00000000-0000-4000-8000-000000000304' as never,
  expiresAt: '2099-08-12T12:00:00.000Z',
  idempotencyKey: 'browser-session-manager-test',
  operationKey,
  payload: { args, runId: commandRunId, ...(expected ? {
    expected_commit: expected.commit,
    expected_manifest_digest: expected.manifest_digest,
  } : {}) },
})

const createGitWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-git-workspace-'))
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

const browserGuest = (): GuestVmSession => ({
  actBrowser: async () => ({ status: 'acted' }),
  closed: new Promise<void>(() => {}),
  closeCodingSession: async () => {},
  inspectRuntime: async () => ({ browser: true, claude: false, codex: false, tmux: false }),
  launchCodingSession: async () => {},
  observeBrowser: async () => ({ accessibilityTree: [], targets: [] }),
  observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running', output: '' }),
  openBrowser: async () => {},
  runCommand: async () => ({ exitCode: 0, output: '', success: true }),
  stop: async () => {},
})

const browserStateFor = (workspaceRoot: string) => ({
  apiBaseUrl: 'https://api.example.test',
  browserSandbox: {
    allowedOrigins: ['https://app.example.test'],
    guestInitrdBuilderPath: '/private/builder',
    guestRuntimeBundlePath: '/private/runtime',
    kernelPath: '/private/kernel',
    vmHelperPath: '/private/helper',
  },
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: ['browser.open', 'browser.observe', 'browser.act', 'sandbox.stop'],
    profiles: ['workspace_sandbox'],
    revision: 1,
  },
  executorId: '00000000-0000-4000-8000-000000000305',
  machinePrivateKey: 'private',
  machinePublicKey: 'public',
  workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
})

test('browser sessions use the exact run lease, reject a second launch, and stop before sandbox teardown', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-manager-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-workspace-'))
  let resolveClosed: (() => void) | undefined
  let starts = 0
  let stops = 0
  const actions: Array<Record<string, unknown>> = []
  const opened: string[] = []
  const session: GuestVmSession = {
    actBrowser: async (action) => {
      actions.push(action)
      return { status: 'acted' }
    },
    closed: new Promise<void>((resolve) => { resolveClosed = resolve }),
    closeCodingSession: async () => {},
    inspectRuntime: async () => ({ browser: true, claude: false, codex: false, tmux: false }),
    launchCodingSession: async () => {},
    observeBrowser: async () => ({
      accessibilityTree: [{ name: 'Save', nodeId: 9, role: 'button' }],
      targets: [{ title: 'Guide', type: 'page', url: 'https://app.example.test/guide' }],
    }),
    observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running', output: '' }),
    openBrowser: async (url) => { opened.push(url) },
    runCommand: async () => ({ exitCode: 0, output: '', success: true }),
    stop: async () => { stops += 1; resolveClosed?.() },
  }
  const state = {
    apiBaseUrl: 'https://api.example.test',
    browserSandbox: {
      allowedOrigins: ['https://app.example.test'],
      guestInitrdBuilderPath: '/private/builder',
      guestRuntimeBundlePath: '/private/runtime',
      kernelPath: '/private/kernel',
      vmHelperPath: '/private/helper',
    },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['browser.open', 'browser.observe', 'browser.act', 'sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000305',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
  }
  try {
    const manager = createExecutorBrowserSessionManager(stateDir, state, {
      startSession: async (input) => {
        starts += 1
        assert.equal(input.lease.runId, runId)
        assert.equal(input.lease.bindingFence, '1')
        assert.deepEqual(input.egressPolicy, { allowedOrigins: ['https://app.example.test'] })
        return session
      },
    })
    assert.deepEqual(
      await manager.open(commandFor('browser.open', { url: 'https://blocked.example.test/' }), runId),
      { code: 'EXECUTOR_BROWSER_DENIED', success: false },
    )
    assert.equal(starts, 0)
    assert.deepEqual(
      await manager.open(commandFor('browser.open', { url: 'https://app.example.test/guide' }), runId),
      { status: 'opened', success: true },
    )
    assert.deepEqual(opened, ['https://app.example.test/guide'])
    assert.deepEqual(
      await manager.open(commandFor('browser.open', { url: 'https://app.example.test/again' }), runId),
      { code: 'EXECUTOR_BROWSER_SESSION_USED', success: false },
    )
    assert.deepEqual(
      await manager.open(
        commandFor('browser.open', { url: 'https://app.example.test/second' }, secondRunId),
        secondRunId,
      ),
      { code: 'EXECUTOR_BROWSER_CAPACITY_REACHED', success: false },
    )
    assert.deepEqual(
      await manager.observe(commandFor('browser.observe', {}), runId),
      {
        accessibilityTree: [{ name: 'Save', nodeId: 9, role: 'button' }],
        success: true,
        targets: [{ title: 'Guide', type: 'page', url: 'https://app.example.test/guide' }],
      },
    )
    assert.deepEqual(
      await manager.act(commandFor('browser.act', { action: 'navigate', url: 'https://blocked.example.test/' }), runId),
      { code: 'EXECUTOR_BROWSER_DENIED', success: false },
    )
    assert.deepEqual(
      await manager.act(commandFor('browser.act', { action: 'click', nodeId: 9 }), runId),
      { status: 'acted', success: true },
    )
    assert.deepEqual(actions, [{ action: 'click', nodeId: 9 }])
    assert.equal(await manager.stop(runId), true)
    assert.equal(stops, 1)
    assert.deepEqual(
      await manager.open(commandFor('browser.open', { url: 'https://app.example.test/reopen' }), runId),
      { code: 'EXECUTOR_BROWSER_SESSION_USED', success: false },
    )
    assert.deepEqual(
      await manager.observe(commandFor('browser.observe', {}), runId),
      { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false },
    )
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('browser session startup is cancelled by fencing before it can open a page', { skip: WINDOWS_STATE_HELPER_SKIP, timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-fence-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-fence-workspace-'))
  let resolveStart: ((value: GuestVmSession) => void) | undefined
  let signalStart: (() => void) | undefined
  let resolveClosed: (() => void) | undefined
  let opens = 0
  let stops = 0
  const startGate = new Promise<GuestVmSession>((resolve) => { resolveStart = resolve })
  const started = new Promise<void>((resolve) => { signalStart = resolve })
  const session: GuestVmSession = {
    actBrowser: async () => ({ status: 'acted' }),
    closed: new Promise<void>((resolve) => { resolveClosed = resolve }),
    closeCodingSession: async () => {},
    inspectRuntime: async () => ({ browser: true, claude: false, codex: false, tmux: false }),
    launchCodingSession: async () => {},
    observeBrowser: async () => ({ accessibilityTree: [], targets: [] }),
    observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running', output: '' }),
    openBrowser: async () => { opens += 1 },
    runCommand: async () => ({ exitCode: 0, output: '', success: true }),
    stop: async () => { stops += 1; resolveClosed?.() },
  }
  const state = {
    apiBaseUrl: 'https://api.example.test',
    browserSandbox: {
      allowedOrigins: ['https://app.example.test'],
      guestInitrdBuilderPath: '/private/builder',
      guestRuntimeBundlePath: '/private/runtime',
      kernelPath: '/private/kernel',
      vmHelperPath: '/private/helper',
    },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['browser.open', 'browser.observe', 'browser.act', 'sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000305',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
  }
  try {
    const manager = createExecutorBrowserSessionManager(stateDir, state, {
      startSession: async () => {
        signalStart?.()
        return startGate
      },
    })
    const opening = manager.open(commandFor('browser.open', { url: 'https://app.example.test/guide' }), runId)
    await started
    const stopping = manager.stopAll()
    resolveStart?.(session)
    await stopping
    assert.deepEqual(await opening, { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false })
    assert.equal(opens, 0)
    assert.equal(stops, 1)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('failed browser startup releases the exact COW lease so sandbox.stop can tear it down', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-lease-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-lease-workspace-'))
  const state = {
    apiBaseUrl: 'https://api.example.test',
    browserSandbox: {
      allowedOrigins: ['https://app.example.test'],
      guestInitrdBuilderPath: '/private/builder',
      guestRuntimeBundlePath: '/private/runtime',
      kernelPath: '/private/kernel',
      vmHelperPath: '/private/helper',
    },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['browser.open', 'browser.observe', 'browser.act', 'sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000305',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
  }
  try {
    const manager = createExecutorBrowserSessionManager(stateDir, state, {
      startSession: async () => { throw new Error('guest unavailable') },
    })
    assert.deepEqual(
      await manager.open(commandFor('browser.open', { url: 'https://app.example.test/guide' }), runId),
      { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false },
    )
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('a rejected guest stop cannot strand a startup lease', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-stop-lease-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-stop-lease-workspace-'))
  const state = {
    apiBaseUrl: 'https://api.example.test',
    browserSandbox: {
      allowedOrigins: ['https://app.example.test'],
      guestInitrdBuilderPath: '/private/builder',
      guestRuntimeBundlePath: '/private/runtime',
      kernelPath: '/private/kernel',
      vmHelperPath: '/private/helper',
    },
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['browser.open', 'browser.observe', 'browser.act', 'sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000305',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
  }
  try {
    const manager = createExecutorBrowserSessionManager(stateDir, state, {
      startSession: async () => ({
        actBrowser: async () => ({ status: 'acted' }),
        closed: new Promise<void>(() => {}),
        closeCodingSession: async () => {},
        inspectRuntime: async () => ({ browser: false, claude: false, codex: false, tmux: false }),
        launchCodingSession: async () => {},
        observeBrowser: async () => ({ accessibilityTree: [], targets: [] }),
        observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running', output: '' }),
        openBrowser: async () => {},
        runCommand: async () => ({ exitCode: 0, output: '', success: true }),
        stop: async () => { throw new Error('guest stop failed') },
      }),
    })
    assert.deepEqual(
      await manager.open(commandFor('browser.open', { url: 'https://app.example.test/guide' }), runId),
      { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false },
    )
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('browser lease verification admits the real clean COW Git workspace before starting a guest', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-lease-verify-'))
  const workspaceRoot = await createGitWorkspace()
  let started = 0
  let leaseWorkspace: string | undefined
  try {
    const expected = await createDeepTestSourceSnapshot(workspaceRoot, workspaceRoot)
    const manager = createExecutorBrowserSessionManager(stateDir, browserStateFor(workspaceRoot), {
      startSession: async (input) => { started += 1; leaseWorkspace = input.lease.workspace; return browserGuest() },
      verifyLease: matchesReviewedLease,
    })
    assert.deepEqual(
      await manager.open(
        commandFor('browser.open', { url: 'https://app.example.test/guide' }, runId, expected),
        runId,
      ),
      { status: 'opened', success: true },
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

test('browser lease verification rejects a workspace changed after review before any guest starts', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-lease-mutation-'))
  const workspaceRoot = await createGitWorkspace()
  let started = 0
  let copiedSnapshotState: 'clean' | 'dirty' | undefined
  try {
    const expected = await createDeepTestSourceSnapshot(workspaceRoot, workspaceRoot)
    await writeFile(join(workspaceRoot, 'app.ts'), 'export const reviewed = false\n')
    const manager = createExecutorBrowserSessionManager(stateDir, browserStateFor(workspaceRoot), {
      startSession: async () => { started += 1; return browserGuest() },
      verifyLease: async (lease, command) => {
        const snapshot = await createDeepTestSourceSnapshot(lease.workspace, lease.workspace)
        copiedSnapshotState = snapshot.working_tree_state
        return snapshot.working_tree_state === 'clean'
          && snapshot.commit === command.payload.expected_commit
          && snapshot.manifest_digest === command.payload.expected_manifest_digest
      },
    })
    assert.deepEqual(
      await manager.open(
        commandFor('browser.open', { url: 'https://app.example.test/guide' }, runId, expected),
        runId,
      ),
      { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false },
    )
    assert.equal(copiedSnapshotState, 'dirty')
    assert.equal(started, 0)
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('cancelling browser lease verification prevents guest startup and releases its COW lease', { skip: WINDOWS_STATE_HELPER_SKIP, timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-browser-lease-cancel-'))
  const workspaceRoot = await createGitWorkspace()
  let releaseVerification: ((value: boolean) => void) | undefined
  let signalVerification: (() => void) | undefined
  let started = 0
  const verification = new Promise<boolean>((resolve) => { releaseVerification = resolve })
  const verificationStarted = new Promise<void>((resolve) => { signalVerification = resolve })
  try {
    const expected = await createDeepTestSourceSnapshot(workspaceRoot, workspaceRoot)
    const manager = createExecutorBrowserSessionManager(stateDir, browserStateFor(workspaceRoot), {
      startSession: async () => { started += 1; return browserGuest() },
      verifyLease: async (lease, command) => {
        assert.equal(await matchesReviewedLease(lease, command), true)
        signalVerification?.()
        return await verification
      },
    })
    const opening = manager.open(
      commandFor('browser.open', { url: 'https://app.example.test/guide' }, runId, expected),
      runId,
    )
    await verificationStarted
    const stopping = manager.stopAll()
    releaseVerification?.(true)
    await stopping
    assert.deepEqual(await opening, { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false })
    assert.equal(started, 0)
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})
