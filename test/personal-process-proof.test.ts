import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { PersonalInferenceAuthority } from '@nessie/executor-protocol'
import { AgentProcessStopUnproved, startAgentProcess } from '../src/coding-session/agent-process.js'
import { createCodingProcessControl, type CodingProcessControl } from '../src/coding-session/process-control.js'
import { codingSessionPaths } from '../src/coding-session/session-files.js'
import { PersonalInferenceGuard } from '../src/personal-inference-guard.js'
import { cancelExecutorMcpProcessTree, stopExecutorMcpProcessTree } from '../src/mcp-command-process.js'
import { GuardedStdioTransport } from '../src/mcp-host-execution.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { verifyInferenceTestState } from './fixtures/local-inference-security.js'

const principal = { serverOrigin: 'https://selfhost.example', identityIssuer: 'https://identity.example',
  organizationId: 'org', teamId: 'team', ownerUserId: 'owner', ownerSubject: 'subject' }
const authority: PersonalInferenceAuthority = { principal, agent: { kind: 'private', id: 'agent', ownerUserId: 'owner', teamId: 'team' },
  origin: { kind: 'interactive', requestingUserId: 'owner', rootRunId: 'root' },
  runId: 'run', rootRunId: 'root', soleReaderUserId: 'owner' }

test('failed process tables and surviving descendants produce unknown, never a tree-stop proof', async () => {
  const failed = createCodingProcessControl('darwin', { ps: async () => undefined, termGraceMs: 0 })
  assert.equal(await failed.stopTree!({ pid: 999_999, startedAt: '100' }), 'unknown')
  const start = 'Tue Sep 23 10:00:00 2026'
  const rows = `999999 1 999999 ${start}\n999998 999999 999999 ${start}`
  const survived = createCodingProcessControl('darwin', { ps: async () => rows, termGraceMs: 0, signal: () => undefined })
  assert.equal(await survived.stopTree!({ pid: 999_999, startedAt: String(Date.UTC(2026, 8, 23, 10) / 1_000) }), 'unknown')
  await assert.rejects(stopExecutorMcpProcessTree(undefined, failed), /could not be proved/u)
  await assert.rejects(stopExecutorMcpProcessTree(undefined, failed, { pid: 999_999, startedAt: '100' }), /could not be proved/u)
})

test('ordinary MCP cancellation uses recorded identity without turning a sweep into custody proof', async () => {
  const identity = { pid: 999_999, startedAt: '100' }
  const control = createCodingProcessControl('darwin', { ps: async () => undefined })
  let killed = false
  control.identify = async () => { throw new Error('must retain the birth identity') }
  control.killTree = async (recorded) => { assert.deepEqual(recorded, identity); killed = true }
  control.stopTree = async () => { throw new Error('ordinary cancellation cannot request custody release') }
  await cancelExecutorMcpProcessTree(undefined, control, identity)
  assert.equal(killed, true)
  await assert.rejects(stopExecutorMcpProcessTree(undefined, control, identity), /cannot request custody release/u)
})

test('an emptied POSIX group and visible tree still cannot prove escaped descendants stopped', async () => {
  const start = 'Tue Sep 23 10:00:00 2026'
  let reads = 0
  const signals: number[] = []
  const control = createCodingProcessControl('darwin', { termGraceMs: 0,
    ps: async () => ++reads === 1 ? `999999 1 999999 ${start}` : `1 0 1 ${start}`,
    signal: (pid) => { signals.push(pid) },
  })
  assert.equal(await control.stopTree!({ pid: 999_999, startedAt: String(Date.UTC(2026, 8, 23, 10) / 1_000) }), 'unknown')
  assert.ok(signals.includes(-999_999), 'the operational group sweep still runs')
  assert.ok(reads >= 3, 'absence was confirmed by a fresh table after signalling')
})

test('stdio transport retains birth generation even without a personal execution lease', async () => {
  const control = createCodingProcessControl()
  control.identify = async (pid) => ({ pid, startedAt: '100' })
  const transport = new GuardedStdioTransport({ command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 600000)'], stderr: 'ignore' }, control, null)
  try {
    await transport.start()
    assert.deepEqual(transport.processIdentity, { pid: transport.pid, startedAt: '100' })
  } finally { await transport.close() }
})

test('natural coding exit retains child birth evidence and lease until positive tree-stop proof', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-process-proof-'))
  const security = { platform: 'win32' as const, helper: verifyInferenceTestState }
  await ensureOwnerOnlyStateDirectory(directory, security)
  const bootId = randomUUID()
  const guard = PersonalInferenceGuard.open({ directory, security,
    processIdentity: async () => ({ pid: process.pid, startedAt: '200', bootId }),
    kernelBootId: async () => bootId,
    admissionLock: { kernelBootId: async () => bootId,
      processes: { identify: async (pid) => ({ pid, startedAt: '200' }), isAlive: () => true } },
    verifyRuntimeInventory: async () => true,
  })
  const paths = codingSessionPaths(directory, randomUUID())
  let verdict: 'stopped' | 'unknown' = 'unknown'
  const control: CodingProcessControl = {
    spawnAgent: (command, args, options) => spawn(command, args, { ...options, windowsHide: true, stdio: 'pipe' }),
    identify: async (pid) => ({ pid, startedAt: '100' }),
    descendants: async () => [], killTree: async () => undefined, killChildTree: async () => false,
    stopTree: async () => verdict,
  }
  const packaged = process.env.NESSIE_EXECUTOR_PACKAGED_CLI
  process.env.NESSIE_EXECUTOR_PACKAGED_CLI = '1'
  try {
    await mkdir(paths.dir, { recursive: true })
    const child = await startAgentProcess({ control, paths, folder: directory, env: process.env,
      log: () => undefined, personalAuthority: authority, personalGuard: guard,
    }, [process.execPath, '-e', 'setTimeout(() => process.exit(0), 50)'], () => undefined)
    assert.equal((await child.exited).clearance, 'unknown')
    let registrations = (await guard.status()).registrations
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0]!.execution!.identity.pid, child.identity.pid)
    assert.equal(registrations[0]!.execution!.identity.startedAt, '100')
    assert.equal(await child.confirmHostExecutionStopped!(), false)
    verdict = 'stopped'
    assert.equal(await child.confirmHostExecutionStopped!(), true)
    registrations = (await guard.status()).registrations
    assert.equal(registrations.length, 0)
    await assert.rejects(startAgentProcess({ control: { ...control, spawnAgent: () => { throw new Error('no spawn') } },
      paths, folder: directory, env: process.env, log: () => undefined,
      personalAuthority: authority, personalGuard: guard,
    }, ['missing'], () => undefined), /no spawn/u)
    assert.equal((await guard.status()).registrations.length, 0)
  } finally {
    if (packaged === undefined) delete process.env.NESSIE_EXECUTOR_PACKAGED_CLI
    else process.env.NESSIE_EXECUTOR_PACKAGED_CLI = packaged
    await rm(directory, { recursive: true, force: true })
  }
})

test('every coding child retains stop debt without a personal lease, and retries only clearance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-no-lease-proof-'))
  const paths = codingSessionPaths(directory, randomUUID())
  const security = { platform: 'win32' as const, helper: verifyInferenceTestState }
  await ensureOwnerOnlyStateDirectory(directory, security)
  const guard = PersonalInferenceGuard.open({ directory, security })
  const packaged = process.env.NESSIE_EXECUTOR_PACKAGED_CLI
  delete process.env.NESSIE_EXECUTOR_PACKAGED_CLI
  let verdict: 'stopped' | 'unknown' = 'unknown'
  let proofs = 0
  let childClosed: Promise<void> | undefined
  const control: CodingProcessControl = {
    spawnAgent: (command, args, options) => {
      const child = spawn(command, args, { ...options, windowsHide: true, stdio: 'pipe' })
      childClosed = new Promise(resolve => child.once('close', () => resolve()))
      return child
    },
    identify: async pid => ({ pid, startedAt: '100' }),
    descendants: async () => [], killTree: async () => undefined, killChildTree: async () => false,
    stopTree: async () => { proofs++; return verdict },
  }
  try {
    await mkdir(paths.dir, { recursive: true })
    const context = { control, paths, folder: directory, env: process.env, log: () => undefined, personalGuard: guard }
    const child = await startAgentProcess(context,
      [process.execPath, '-e', 'setTimeout(() => process.exit(0), 50)'], () => undefined)
    assert.deepEqual(await child.exited, { code: 0, clearance: 'unknown' })
    assert.equal(await child.confirmHostExecutionStopped(), false)
    verdict = 'stopped'
    assert.equal(await child.confirmHostExecutionStopped(), true)
    const proved = proofs
    assert.equal(await child.confirmHostExecutionStopped(), true)
    assert.equal(proofs, proved, 'cleared child cannot acquire a new stop debt')
    const { stopTree: _stopTree, ...withoutProof } = control
    await assert.rejects(startAgentProcess({ ...context, control: { ...withoutProof,
      spawnAgent: () => { throw new Error('must refuse before spawn') },
    } }, ['fixture'], () => undefined), AgentProcessStopUnproved)
    await assert.rejects(startAgentProcess({ ...context, control: { ...control,
      identify: async () => undefined,
    } }, [process.execPath, '-e', 'process.exit(0)'], () => undefined), error => (
      error instanceof AgentProcessStopUnproved && error.spawnedPid !== undefined && error.identity === undefined
    ))
  } finally {
    await childClosed
    if (packaged === undefined) delete process.env.NESSIE_EXECUTOR_PACKAGED_CLI
    else process.env.NESSIE_EXECUTOR_PACKAGED_CLI = packaged
    await rm(directory, { recursive: true, force: true })
  }
})
