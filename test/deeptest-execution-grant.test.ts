import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  clearExecutorState,
  deepTestExecutionGrantPath,
  loadExecutorDeepTestExecutionGrant,
  publishExecutorDeepTestExecutionGrant,
  revokeExecutorDeepTestExecutionGrant,
  saveExecutorState,
  type ExecutorLocalState,
} from '../src/state-store.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const stateFor = (workspaceRoot: string, revision = 1): ExecutorLocalState => ({
  apiBaseUrl: 'https://api.nessie.example',
  browserSandbox: {
    allowedOrigins: ['https://assessment.example'],
    guestInitrdBuilderPath: '/private/vm/build-initrd',
    guestRuntimeBundlePath: '/private/vm/runtime',
    kernelPath: '/private/vm/kernel',
    vmHelperPath: '/private/vm/helper',
  },
  connectionEpoch: 'private-connection-epoch',
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: ['file.list', 'file.read', 'workspace.review', 'sandbox.stop', 'command.run'],
    profiles: ['workspace_sandbox'],
    revision,
  },
  executorId: '00000000-0000-4000-8000-000000000005',
  machinePrivateKey: 'machine-private-secret',
  machinePublicKey: 'machine-public-value',
  workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
})

const fixture = async (): Promise<{ stateDir: string; workspaceRoot: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-execution-grant-'))
  const stateDir = join(root, 'state')
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot)
  return { stateDir, workspaceRoot }
}

test('only explicit active-testing opt-in publishes a credential-free execution grant', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const state = stateFor(workspaceRoot)
    await saveExecutorState(stateDir, state)

    const path = await publishExecutorDeepTestExecutionGrant(stateDir, { activeTesting: true })
    const raw = await readFile(path, 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(raw) as object).sort(), [
      'browser', 'descriptor', 'executorId', 'runtime', 'workspaceFolders',
    ])
    assert.doesNotMatch(
      raw,
      /"(?:apiBaseUrl|connectionEpoch|machinePrivateKey|machinePublicKey|codexAuthProfilePath|privateBrowserProfile)"/u,
    )
    assert.deepEqual(await loadExecutorDeepTestExecutionGrant(path), {
      browser: { allowedOrigins: ['https://assessment.example'] },
      descriptor: state.descriptor,
      executorId: state.executorId,
      runtime: {
        guestInitrdBuilderPath: '/private/vm/build-initrd',
        guestRuntimeBundlePath: '/private/vm/runtime',
        kernelPath: '/private/vm/kernel',
        vmHelperPath: '/private/vm/helper',
      },
      workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
    })
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

test('a source-only pairing cannot mint an active execution grant', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const sourceOnly = stateFor(workspaceRoot)
    delete sourceOnly.browserSandbox
    sourceOnly.descriptor.operationKeys = ['file.list', 'file.read']
    await saveExecutorState(stateDir, sourceOnly)

    await assert.rejects(
      publishExecutorDeepTestExecutionGrant(stateDir, { activeTesting: true }),
      /requires configured local VM execution operations/u,
    )
    await assert.rejects(readFile(deepTestExecutionGrantPath(stateDir), 'utf8'), /ENOENT/u)
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

test('a changed descriptor revokes execution access before a failed state save', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const original = stateFor(workspaceRoot)
    await saveExecutorState(stateDir, original)
    await publishExecutorDeepTestExecutionGrant(stateDir, { activeTesting: true })

    await assert.rejects(saveExecutorState(stateDir, stateFor(workspaceRoot, 2), original, {
      replaceJson: async (path) => {
        if (path.endsWith('executor-state.json')) throw new Error('simulated state save failure')
      },
    }), /simulated state save failure/u)
    await assert.rejects(readFile(deepTestExecutionGrantPath(stateDir), 'utf8'), /ENOENT/u)
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})

test('revocation and forget remove an execution grant, and malformed grants fail closed', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const { stateDir, workspaceRoot } = await fixture()
  try {
    const state = stateFor(workspaceRoot)
    await saveExecutorState(stateDir, state)
    const path = await publishExecutorDeepTestExecutionGrant(stateDir, { activeTesting: true })
    await revokeExecutorDeepTestExecutionGrant(stateDir)
    await assert.rejects(readFile(path, 'utf8'), /ENOENT/u)

    await publishExecutorDeepTestExecutionGrant(stateDir, { activeTesting: true })
    await writeFile(path, `${JSON.stringify({
      ...JSON.parse(await readFile(path, 'utf8')) as object,
      privateBrowserProfile: 'forbidden',
    })}\n`)
    await assert.rejects(loadExecutorDeepTestExecutionGrant(path), /malformed/u)

    await clearExecutorState(stateDir)
    await assert.rejects(readFile(deepTestExecutionGrantPath(stateDir), 'utf8'), /ENOENT/u)
  } finally {
    await rm(join(stateDir, '..'), { force: true, recursive: true })
  }
})
