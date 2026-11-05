import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import { CODEX_EGRESS_ORIGINS, createExecutorCodingSessionManager } from '../src/coding-session-manager.js'
import type { GuestVmSession } from '../src/guest-vm-session.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const runId = '00000000-0000-4000-8000-000000000351'

const commandFor = (
  operationKey: 'coding.launch' | 'coding.observe',
  args: Record<string, unknown>,
): ExecutorCommandEnvelope => ({
  argumentDigest: `sha256:${'0'.repeat(64)}` as never,
  bindingFence: '1',
  bindingId: '00000000-0000-4000-8000-000000000352' as never,
  capabilityRevision: 1,
  commandId: operationKey === 'coding.launch'
    ? '00000000-0000-4000-8000-000000000353' as never
    : '00000000-0000-4000-8000-000000000354' as never,
  expiresAt: '2099-08-12T12:00:00.000Z',
  idempotencyKey: 'coding-session-manager-test',
  operationKey,
  payload: { args, runId },
})

const stateFor = (workspaceRoot: string) => ({
  apiBaseUrl: 'https://api.example.test',
  codexSandbox: {
    codexAuthProfilePath: '/private/codex-auth.json',
    guestInitrdBuilderPath: '/private/build-initrd',
    guestRuntimeBundlePath: '/private/runtime',
    kernelPath: '/private/kernel',
    vmHelperPath: '/private/vm-helper',
  },
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: ['coding.launch', 'coding.observe', 'workspace.review', 'sandbox.stop'],
    profiles: ['workspace_sandbox', 'coding_session'],
    revision: 1,
  },
  executorId: '00000000-0000-4000-8000-000000000355',
  machinePrivateKey: 'private',
  machinePublicKey: 'public',
  workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
})

test('Codex sessions use the private guest profile and expose typed lifecycle only', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-coding-manager-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-coding-workspace-'))
  let resolveClosed: (() => void) | undefined
  let launches = 0
  let stops = 0
  const session: GuestVmSession = {
    closed: new Promise<void>((resolve) => { resolveClosed = resolve }),
    closeCodingSession: async () => {},
    inspectRuntime: async () => ({ browser: false, claude: false, codex: true, tmux: true }),
    launchCodingSession: async (agent, prompt) => {
      launches += 1
      assert.equal(agent, 'codex')
      assert.equal(prompt, 'Fix the failing unit test')
    },
    observeBrowser: async () => ({ targets: [] }),
    observeCodingSession: async () => ({
      agent: 'codex',
      exitStatus: 0,
      lifecycle: 'exited',
    }),
    openBrowser: async () => {},
    stop: async () => { stops += 1; resolveClosed?.() },
  }
  try {
    const manager = createExecutorCodingSessionManager(stateDir, stateFor(workspaceRoot), {
      startSession: async (input) => {
        assert.equal(input.codexAuthProfilePath, '/private/codex-auth.json')
        assert.deepEqual(input.egressPolicy, { allowedOrigins: [...CODEX_EGRESS_ORIGINS] })
        assert.equal(input.lease.runId, runId)
        assert.equal(input.lease.bindingFence, '1')
        return session
      },
    })
    assert.deepEqual(
      await manager.launch(commandFor('coding.launch', { prompt: 'Fix the failing unit test' }), runId),
      { status: 'started', success: true },
    )
    assert.equal(launches, 1)
    const observed = await manager.observe(commandFor('coding.observe', {}), runId)
    assert.deepEqual(observed, { agent: 'codex', exitStatus: 0, lifecycle: 'exited', success: true })
    assert.deepEqual(
      await manager.launch(commandFor('coding.launch', { prompt: 'try again' }), runId),
      { code: 'EXECUTOR_CODING_SESSION_USED', success: false },
    )
    assert.equal(await manager.stop(runId), true)
    assert.equal(stops, 1)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})

test('fencing an in-flight Codex session destroys it before a prompt can launch', { skip: WINDOWS_STATE_HELPER_SKIP, timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-coding-fence-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'nessie-executor-coding-fence-workspace-'))
  let resolveClosed: (() => void) | undefined
  let resolveStart: ((value: GuestVmSession) => void) | undefined
  let signalStart: (() => void) | undefined
  let launches = 0
  let stops = 0
  const startGate = new Promise<GuestVmSession>((resolve) => { resolveStart = resolve })
  const started = new Promise<void>((resolve) => { signalStart = resolve })
  const session: GuestVmSession = {
    closed: new Promise<void>((resolve) => { resolveClosed = resolve }),
    closeCodingSession: async () => {},
    inspectRuntime: async () => ({ browser: false, claude: false, codex: true, tmux: true }),
    launchCodingSession: async () => { launches += 1 },
    observeBrowser: async () => ({ targets: [] }),
    observeCodingSession: async () => ({ agent: 'codex', lifecycle: 'running' }),
    openBrowser: async () => {},
    stop: async () => { stops += 1; resolveClosed?.() },
  }
  try {
    const manager = createExecutorCodingSessionManager(stateDir, stateFor(workspaceRoot), {
      startSession: async () => {
        signalStart?.()
        return startGate
      },
    })
    const launching = manager.launch(commandFor('coding.launch', { prompt: 'Fix the failing unit test' }), runId)
    await started
    const stopping = manager.stopAll()
    resolveStart?.(session)
    await stopping
    assert.deepEqual(await launching, { code: 'EXECUTOR_CODING_UNAVAILABLE', success: false })
    assert.equal(launches, 0)
    assert.equal(stops, 1)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
    await rm(workspaceRoot, { force: true, recursive: true })
  }
})
