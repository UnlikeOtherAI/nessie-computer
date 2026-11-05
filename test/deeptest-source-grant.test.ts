import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  clearExecutorState,
  deepTestSourceGrantPath,
  loadExecutorDeepTestSourceGrant,
  loadExecutorState,
  publishExecutorDeepTestSourceGrant,
  saveExecutorState,
  type ExecutorLocalState,
} from '../src/state-store.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const stateFor = (
  workspaceRoot: string,
  revision = 1,
  operationKeys = ['file.list', 'file.read'],
): ExecutorLocalState => ({
  apiBaseUrl: 'https://api.nessie.example',
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys,
    profiles: ['workspace_sandbox'],
    revision,
  },
  executorId: '00000000-0000-4000-8000-000000000005',
  machinePrivateKey: 'machine-private-secret',
  machinePublicKey: 'machine-public-value',
  workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
})

const fixture = async (): Promise<{ stateDir: string; workspaceRoot: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-source-grant-'))
  const stateDir = join(root, 'state')
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot)
  return { stateDir, workspaceRoot }
}

test('paired state publishes an exact credential-free source grant', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const original = stateFor(workspaceRoot)
    const state = {
      ...original,
      descriptor: {
        ...original.descriptor,
        limits: { ...original.descriptor.limits, privateBudgetToken: 'nested-secret' },
        providerCredential: 'descriptor-secret',
      },
    } as ExecutorLocalState
    await saveExecutorState(stateDir, state)

    const grantPath = deepTestSourceGrantPath(stateDir)
    const raw = await readFile(grantPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    assert.deepEqual(Object.keys(parsed).sort(), ['descriptor', 'executorId', 'workspaceFolders'])
    assert.doesNotMatch(
      raw,
      /apiBaseUrl|machinePrivateKey|machinePublicKey|privateBudgetToken|providerCredential|secret/u,
    )
    assert.deepEqual(await loadExecutorDeepTestSourceGrant(grantPath), {
      descriptor: original.descriptor,
      executorId: state.executorId,
      workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
    })
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

test('connection-only state saves preserve the existing valid source grant', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const state = stateFor(workspaceRoot)
    await saveExecutorState(stateDir, state)
    const grantPath = deepTestSourceGrantPath(stateDir)
    const fixedTime = new Date('2020-01-02T03:04:05.000Z')
    await utimes(grantPath, fixedTime, fixedTime)

    await saveExecutorState(
      stateDir,
      { ...state, apiBaseUrl: 'https://moved.nessie.example' },
      state,
    )

    assert.equal((await stat(grantPath)).mtimeMs, fixedTime.getTime())
    assert.equal((await loadExecutorState(stateDir)).apiBaseUrl, 'https://moved.nessie.example')
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

test('a changed source projection is revoked before a failed paired-state save', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const original = stateFor(workspaceRoot)
    await saveExecutorState(stateDir, original)

    await assert.rejects(saveExecutorState(stateDir, stateFor(workspaceRoot, 2), original, {
      replaceJson: async (path) => {
        if (path.endsWith('executor-state.json')) throw new Error('simulated state save failure')
      },
    }), /simulated state save failure/u)
    await assert.rejects(readFile(deepTestSourceGrantPath(stateDir), 'utf8'), /ENOENT/u)
    assert.equal((await loadExecutorState(stateDir)).descriptor.revision, 1)

    await saveExecutorState(
      stateDir,
      { ...original, connectionEpoch: 'later-connection-only-save' },
      original,
    )
    await assert.rejects(readFile(deepTestSourceGrantPath(stateDir), 'utf8'), /ENOENT/u)
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

test('the explicit locked recovery command republishes authoritative paired state', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const state = stateFor(workspaceRoot)
    await saveExecutorState(stateDir, state)
    await unlink(deepTestSourceGrantPath(stateDir))

    const published = await publishExecutorDeepTestSourceGrant(stateDir)

    assert.equal(published, deepTestSourceGrantPath(stateDir))
    assert.equal((await loadExecutorDeepTestSourceGrant(published)).executorId, state.executorId)
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

test('connection metadata cannot republish after source-grant publication fails', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const original = stateFor(workspaceRoot)
    const changed = stateFor(workspaceRoot, 2, ['file.list'])
    await saveExecutorState(stateDir, original)

    await assert.rejects(saveExecutorState(stateDir, changed, original, {
      replaceJson: async (path, value) => {
        if (path.endsWith('deeptest-source-grant.json')) {
          throw new Error('simulated grant publication failure')
        }
        await writeFile(path, `${JSON.stringify(value)}\n`)
      },
    }), /simulated grant publication failure/u)
    await assert.rejects(readFile(deepTestSourceGrantPath(stateDir), 'utf8'), /ENOENT/u)
    assert.equal((await loadExecutorState(stateDir)).descriptor.revision, 2)

    await saveExecutorState(
      stateDir,
      { ...changed, connectionEpoch: 'later-connection-only-save' },
      changed,
    )
    await assert.rejects(readFile(deepTestSourceGrantPath(stateDir), 'utf8'), /ENOENT/u)
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

test('a concurrent state mutation cannot race a later grant revocation', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const state = stateFor(workspaceRoot)
    await saveExecutorState(stateDir, state)
    const grantPath = deepTestSourceGrantPath(stateDir)
    const before = await readFile(grantPath, 'utf8')
    await writeFile(join(stateDir, 'executor-state-mutation.lock'), 'another process\n')

    await assert.rejects(saveExecutorState(stateDir, stateFor(workspaceRoot, 2)), /already being updated/u)
    assert.equal(await readFile(grantPath, 'utf8'), before)
    assert.equal((await loadExecutorState(stateDir)).descriptor.revision, 1)
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

test('a delayed writer cannot restore a source capability after revocation', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const original = stateFor(workspaceRoot)
    const revoked = stateFor(workspaceRoot, 2, ['file.list'])
    await saveExecutorState(stateDir, original)
    await saveExecutorState(stateDir, revoked, original)

    await assert.rejects(
      saveExecutorState(stateDir, { ...original, connectionEpoch: 'stale-claim' }, original),
      /changed before this update/u,
    )

    const grant = await loadExecutorDeepTestSourceGrant(deepTestSourceGrantPath(stateDir))
    assert.deepEqual(grant.descriptor, revoked.descriptor)
    assert.deepEqual((await loadExecutorState(stateDir)).descriptor, revoked.descriptor)
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

test('a delayed writer cannot recreate paired state after it is forgotten', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const original = stateFor(workspaceRoot)
    await saveExecutorState(stateDir, original)
    await clearExecutorState(stateDir)

    await assert.rejects(
      saveExecutorState(stateDir, { ...original, connectionEpoch: 'stale-claim' }, original),
      /changed before this update/u,
    )

    await assert.rejects(readFile(deepTestSourceGrantPath(stateDir), 'utf8'), /ENOENT/u)
    await assert.rejects(loadExecutorState(stateDir), /ENOENT/u)
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

test('forgetting paired state invalidates its source grant first', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    await saveExecutorState(stateDir, stateFor(workspaceRoot))
    await clearExecutorState(stateDir)

    await assert.rejects(readFile(deepTestSourceGrantPath(stateDir), 'utf8'), /ENOENT/u)
    await assert.rejects(loadExecutorState(stateDir), /ENOENT/u)
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

test('the source adapter rejects a grant with credential-shaped extra fields', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    await saveExecutorState(stateDir, stateFor(workspaceRoot))
    const grantPath = deepTestSourceGrantPath(stateDir)
    const grant = JSON.parse(await readFile(grantPath, 'utf8')) as Record<string, unknown>
    await writeFile(grantPath, `${JSON.stringify({ ...grant, machinePrivateKey: 'secret' })}\n`)

    await assert.rejects(loadExecutorDeepTestSourceGrant(grantPath), /malformed/u)
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

const packagedBundle = join(dirname(process.execPath), 'nessie-executor.cjs')

test('the staged packaged child serves the credential-free grant', {
  skip: existsSync(packagedBundle)
    ? false
    : 'Needs a packaged executor: its nessie-executor.cjs bundle beside the node running this test.',
}, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const state = stateFor(workspaceRoot)
    await saveExecutorState(stateDir, state)
    const child = spawn(process.execPath, [
      packagedBundle,
      'deeptest-source',
      '--source-grant-file',
      deepTestSourceGrantPath(stateDir),
    ], {
      env: { ...process.env, NESSIE_EXECUTOR_PACKAGED_CLI: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    let errorOutput = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk.toString('utf8') })
    child.stdin.end(`${JSON.stringify({
      account_id: 'account.example',
      operation: 'hello',
      project_id: 'project_00000000-0000-4000-8000-000000000002',
      protocol_version: 1,
      request_id: 'packaged_proof',
      review_id: 'review_00000000-0000-4000-8000-000000000003',
      session_id: 'session_00000000-0000-4000-8000-000000000004',
    })}\n`)
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })

    assert.equal(exitCode, 0, errorOutput)
    const answer = JSON.parse(output.trim()) as { result?: { executor_id?: unknown }; status?: unknown }
    assert.equal(answer.status, 'ok')
    assert.equal(answer.result?.executor_id, state.executorId)
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})
