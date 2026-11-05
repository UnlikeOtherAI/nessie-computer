import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import {
  materializeDeepTestExecutionSource,
  verifyDeepTestExecutionSource,
} from '../src/deeptest-execution-source.js'
import { createDeepTestSourceSnapshot } from '../src/deeptest-source-snapshot.js'
import {
  createGuestWorkspaceLease,
  releaseGuestWorkspaceLease,
} from '../src/guest-workspace-lease.js'
import { stopSandboxWorkspace } from '../src/sandbox-workspace.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const exec = promisify(execFile)
const runId = '00000000-0000-4000-8000-000000000401'

const reviewedRepository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-reviewed-source-'))
  await exec('git', ['init', '--quiet', root])
  await exec('git', ['-C', root, 'config', 'user.email', 'test@example.test'])
  await exec('git', ['-C', root, 'config', 'user.name', 'Nessie Test'])
  await writeFile(join(root, 'app.ts'), 'export const reviewed = true\n')
  await exec('git', ['-C', root, 'add', '.'])
  await exec('git', ['-C', root, 'commit', '--quiet', '-m', 'reviewed source'])
  return root
}

const leaseFor = async (stateDir: string, workspaceRoot: string) => await createGuestWorkspaceLease(
  stateDir,
  { name: 'workspace', path: workspaceRoot },
  {
    bindingFence: '1',
    commandId: '00000000-0000-4000-8000-000000000402',
    runId,
  },
)

test('execution COW leases contain only reviewed Git blobs and never ignored or Git metadata', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-execution-materialized-state-'))
  const root = await reviewedRepository()
  let releaseSource: (() => Promise<void>) | undefined
  let lease: Awaited<ReturnType<typeof leaseFor>> | undefined
  try {
    const snapshot = await createDeepTestSourceSnapshot(root, root)
    await writeFile(join(root, '.env'), 'DATABASE_PASSWORD=not-reviewed\n')
    await appendFile(join(root, '.git', 'config'), '\n[private]\nsentinel = never-in-guest\n')
    const materialized = await materializeDeepTestExecutionSource(stateDir, snapshot)
    releaseSource = materialized.release
    lease = await leaseFor(stateDir, materialized.workspaceRoot)
    await releaseSource()
    releaseSource = undefined

    assert.equal(await readFile(join(lease.workspace, 'app.ts'), 'utf8'), 'export const reviewed = true\n')
    await assert.rejects(readFile(join(lease.workspace, '.env'), 'utf8'))
    await assert.rejects(readFile(join(lease.workspace, '.git', 'config'), 'utf8'))
    assert.equal(await verifyDeepTestExecutionSource(lease.workspace, snapshot), true)
  } finally {
    if (lease) await releaseGuestWorkspaceLease(stateDir, lease).catch(() => undefined)
    await stopSandboxWorkspace(stateDir, runId).catch(() => undefined)
    await releaseSource?.().catch(() => undefined)
    await Promise.all([rm(stateDir, { force: true, recursive: true }), rm(root, { force: true, recursive: true })])
  }
})

test('a tracked mutation in an execution lease denies the final reviewed-source check', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-execution-materialized-state-'))
  const root = await reviewedRepository()
  let releaseSource: (() => Promise<void>) | undefined
  let lease: Awaited<ReturnType<typeof leaseFor>> | undefined
  try {
    const snapshot = await createDeepTestSourceSnapshot(root, root)
    const materialized = await materializeDeepTestExecutionSource(stateDir, snapshot)
    releaseSource = materialized.release
    lease = await leaseFor(stateDir, materialized.workspaceRoot)
    await releaseSource()
    releaseSource = undefined

    await writeFile(join(lease.workspace, 'app.ts'), 'export const reviewed = false\n')
    assert.equal(await verifyDeepTestExecutionSource(lease.workspace, snapshot), false)
  } finally {
    if (lease) await releaseGuestWorkspaceLease(stateDir, lease).catch(() => undefined)
    await stopSandboxWorkspace(stateDir, runId).catch(() => undefined)
    await releaseSource?.().catch(() => undefined)
    await Promise.all([rm(stateDir, { force: true, recursive: true }), rm(root, { force: true, recursive: true })])
  }
})

test('an extra lease path is denied before its contents are read', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-execution-materialized-state-'))
  const root = await reviewedRepository()
  let releaseSource: (() => Promise<void>) | undefined
  let lease: Awaited<ReturnType<typeof leaseFor>> | undefined
  try {
    const snapshot = await createDeepTestSourceSnapshot(root, root)
    const materialized = await materializeDeepTestExecutionSource(stateDir, snapshot)
    releaseSource = materialized.release
    lease = await leaseFor(stateDir, materialized.workspaceRoot)
    await releaseSource()
    releaseSource = undefined

    await writeFile(join(lease.workspace, 'unreviewed-large-file'), 'not admitted')
    assert.equal(await verifyDeepTestExecutionSource(lease.workspace, snapshot), false)
  } finally {
    if (lease) await releaseGuestWorkspaceLease(stateDir, lease).catch(() => undefined)
    await stopSandboxWorkspace(stateDir, runId).catch(() => undefined)
    await releaseSource?.().catch(() => undefined)
    await Promise.all([rm(stateDir, { force: true, recursive: true }), rm(root, { force: true, recursive: true })])
  }
})

test('cancelling source materialization removes its temporary reviewed tree', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-execution-materialized-state-'))
  const root = await reviewedRepository()
  try {
    const snapshot = await createDeepTestSourceSnapshot(root, root)
    let checks = 0
    await assert.rejects(materializeDeepTestExecutionSource(stateDir, snapshot, async () => {
      checks += 1
      if (checks > 1) throw new Error('grant revoked')
    }))
    assert.deepEqual(
      (await readdir(stateDir)).filter((entry) => entry.startsWith('.deeptest-execution-source-')),
      [],
    )
  } finally {
    await Promise.all([rm(stateDir, { force: true, recursive: true }), rm(root, { force: true, recursive: true })])
  }
})
