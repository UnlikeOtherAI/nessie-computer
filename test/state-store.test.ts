import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalExecutorJson, type ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import { executeExecutorCommand } from '../src/daemon.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import {
  promotionManifestForSandbox,
  stopSandboxWorkspace,
  workspaceForRun,
  workspaceViewForRun,
  writeSandboxFile,
} from '../src/sandbox-workspace.js'
import { loadExecutorState, loadExecutorStatesFromRoot, saveExecutorState } from '../src/state-store.js'
import type { ExecutorWorkspaceFolder } from '../src/workspace-folders.js'
import { listWorkspaceFiles, readWorkspaceFile } from '../src/workspace.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const hostView = (...folders: ExecutorWorkspaceFolder[]) => ({
  directoryFor: async (folder: ExecutorWorkspaceFolder) => folder.path,
  folders,
})

const commandFor = (
  operationKey: ExecutorCommandEnvelope['operationKey'],
  payload: Record<string, unknown>,
): ExecutorCommandEnvelope => ({
  argumentDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}` as never,
  bindingFence: '1',
  bindingId: '00000000-0000-4000-8000-000000000201' as never,
  capabilityRevision: 1,
  commandId: '00000000-0000-4000-8000-000000000202' as never,
  expiresAt: '2099-08-12T12:00:00.000Z',
  idempotencyKey: 'executor-command-test',
  operationKey,
  payload,
})

test('state storage rejects shared or symbolic paths and preserves owner-only state', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-test-'))
  const shared = join(root, 'shared')
  const safe = join(root, 'safe')
  const linked = join(root, 'linked')
  const state = {
    apiBaseUrl: 'https://api.example.test',
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000001',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceFolders: [{ name: 'work', path: '/private/tmp/nessie-workspace' }],
  }
  try {
    const packagedWindows = process.platform === 'win32' && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1'
    await saveExecutorState(shared, state)
    if (packagedWindows) {
      const grant = await new Promise<{ code: number | null }>((resolvePromise, reject) => {
        const child = spawn('icacls', [shared, '/grant', '*S-1-1-0:R'], { windowsHide: true })
        child.once('error', reject)
        child.once('exit', (code) => resolvePromise({ code }))
      })
      assert.equal(grant.code, 0)
      await assert.rejects(() => loadExecutorState(shared), /owner-only/)
    } else {
      await chmod(shared, 0o755)
      await assert.rejects(() => loadExecutorState(shared), /must not be accessible/)
    }

    await saveExecutorState(safe, state)
    assert.deepEqual(await loadExecutorState(safe), state)

    await symlink(safe, linked, packagedWindows ? 'junction' : undefined)
    await assert.rejects(
      () => saveExecutorState(linked, state),
      /ordinary directory/u,
    )
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('native-host state-root dispatch accepts only protected matching pairing directories', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-pairings-'))
  const firstId = '00000000-0000-4000-8000-000000000031'
  if (process.platform === 'win32' && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1') {
    await ensureOwnerOnlyStateDirectory(root)
  }
  const secondId = '00000000-0000-4000-8000-000000000032'
  const stateFor = (executorId: string) => ({
    apiBaseUrl: 'https://api.example.test',
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId,
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceFolders: [{ name: 'work', path: '/private/tmp/nessie-workspace' }],
  })
  try {
    await saveExecutorState(join(root, firstId), stateFor(firstId))
    await saveExecutorState(join(root, secondId), stateFor(secondId))
    const mismatchedDirectory = join(root, '00000000-0000-4000-8000-000000000033')
    await saveExecutorState(mismatchedDirectory, stateFor('00000000-0000-4000-8000-000000000034'))
    await mkdir(join(root, 'not-a-pairing'))

    assert.deepEqual(
      (await loadExecutorStatesFromRoot(root)).map((state) => state.executorId),
      [firstId, secondId],
    )
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('the read-only workspace backend keeps every path inside the paired root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-workspace-'))
  const outside = await mkdtemp(join(tmpdir(), 'nessie-executor-outside-'))
  try {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'notes.txt'), 'hello executor')
    await writeFile(join(outside, 'secret.txt'), 'not readable')
    try {
      await symlink(join(outside, 'secret.txt'), join(root, 'outside-link'))
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows symlink creation requires a privilege unavailable to this test process.')
        return
      }
      throw error
    }

    const view = hostView({ name: 'work', path: root })
    assert.deepEqual(
      await listWorkspaceFiles(view, { path: 'work/nested' }),
      {
        entries: [{ kind: 'file', name: 'notes.txt' }],
        path: 'work/nested',
        success: true,
        truncated: false,
      },
    )
    assert.deepEqual(
      await readWorkspaceFile(view, { path: 'work/nested/notes.txt', maxBytes: 5 }),
      {
        byteCount: 5,
        content: 'hello',
        path: 'work/nested/notes.txt',
        success: true,
        truncated: true,
      },
    )
    await assert.rejects(
      readWorkspaceFile(view, { path: 'work/../outside/secret.txt' }),
      /may not contain/,
    )
    await assert.rejects(
      readWorkspaceFile(view, { path: 'work/outside-link' }),
      /symbolic links/,
    )
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  }
})

test('sandbox writes use a daemon-owned COW workspace and never touch the paired root', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-cow-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-cow-state-'))
  const runId = '00000000-0000-4000-8000-000000000101'
  try {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'base.txt'), 'host source')

    const folders = [{ name: 'work', path: root }]
    assert.deepEqual(
      await writeSandboxFile(stateDir, folders, runId, {
        content: 'draft only',
        path: 'work/nested/draft.txt',
      }),
      { byteCount: 10, path: 'work/nested/draft.txt', success: true },
    )
    assert.deepEqual(
      await readWorkspaceFile(
        workspaceViewForRun(stateDir, folders, runId),
        { path: 'work/nested/draft.txt' },
      ),
      {
        byteCount: 10,
        content: 'draft only',
        path: 'work/nested/draft.txt',
        success: true,
        truncated: false,
      },
    )
    assert.equal(await readFile(join(root, 'nested', 'base.txt'), 'utf8'), 'host source')
    await assert.rejects(readFile(join(root, 'nested', 'draft.txt'), 'utf8'), { code: 'ENOENT' })

    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
    assert.equal(await workspaceForRun(stateDir, folders[0]!, runId), await realpath(root))
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('sandbox workspace paths exclude the native promotion journal', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-journal-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-journal-state-'))
  try {
    await mkdir(join(root, '.nessie-executor-promotions'))
    await writeFile(join(root, '.nessie-executor-promotions', 'private.txt'), 'journal secret')
    const folders = [{ name: 'work', path: root }]
    for (const path of [
      'work/.nessie-executor-promotions/private.txt',
      'work/./.nessie-executor-promotions/private.txt',
      'work/.nessie-executor-promotions\\private.txt',
      'work\\.nessie-executor-promotions\\private.txt',
    ]) {
      await assert.rejects(readWorkspaceFile(hostView(...folders), { path }), /journal state/)
      await assert.rejects(
        writeSandboxFile(stateDir, folders, '00000000-0000-4000-8000-000000000105', {
          content: 'forbidden',
          path,
        }),
        /journal state/,
      )
    }
    // A `..` that used to be collapsed away is now refused outright, because a
    // collapsed first segment could name a different folder.
    await assert.rejects(
      readWorkspaceFile(hostView(...folders), {
        path: 'work/ordinary/../.nessie-executor-promotions/private.txt',
      }),
      /may not contain/,
    )
    // The folder's own listing hides the journal; the namespace root lists the
    // folders themselves so an agent can discover what it may reach.
    assert.deepEqual(
      await listWorkspaceFiles(hostView(...folders), { path: 'work' }),
      { entries: [], path: 'work', success: true, truncated: false },
    )
    assert.deepEqual(
      await listWorkspaceFiles(hostView(...folders), { path: '.' }),
      {
        entries: [{ kind: 'directory', name: 'work' }],
        path: '.',
        success: true,
        truncated: false,
      },
    )
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('copy-on-write sandbox setup fails closed on symbolic links in the paired root', { skip: WINDOWS_STATE_HELPER_SKIP }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-cow-link-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-cow-link-state-'))
  const outside = await mkdtemp(join(tmpdir(), 'nessie-executor-cow-link-outside-'))
  try {
    try {
      await symlink(outside, join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : undefined)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
        t.skip('Windows link creation requires a privilege unavailable to this test process.')
        return
      }
      throw error
    }
    await assert.rejects(
      writeSandboxFile(stateDir, [{ name: 'work', path: root }], '00000000-0000-4000-8000-000000000102', {
        content: 'must not write',
        path: 'work/draft.txt',
      }),
      /symbolic links/,
    )
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  }
})

test('daemon commands bind COW drafts to one run and never write the paired root', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-daemon-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-daemon-state-'))
  const runId = '00000000-0000-4000-8000-000000000203'
  const state = {
    apiBaseUrl: 'https://api.example.test',
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.list', 'file.read', 'file.write', 'workspace.review', 'sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000204',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceFolders: [{ name: 'work', path: root }],
  }
  try {
    await writeFile(join(root, 'original.txt'), 'host root')
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('file.write', {
        args: { content: 'draft', path: 'work/draft.txt' },
        runId,
      })),
      { byteCount: 5, path: 'work/draft.txt', success: true },
    )
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('file.read', {
        args: { path: 'work/draft.txt' },
        runId,
      })),
      { byteCount: 5, content: 'draft', path: 'work/draft.txt', success: true, truncated: false },
    )
    await assert.rejects(readFile(join(root, 'draft.txt'), 'utf8'), { code: 'ENOENT' })
    const review = await executeExecutorCommand(stateDir, state, commandFor('workspace.review', {
      args: {},
      runId,
    }))
    assert.deepEqual(review, {
      changeCount: 1,
      changes: [{ byteCount: 5, kind: 'created', path: 'work/draft.txt' }],
      manifestDigest: review.manifestDigest,
      success: true,
    })
    assert.match(String(review.manifestDigest), /^sha256:[a-f0-9]{64}$/)
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('sandbox.stop', { args: {}, runId })),
      { status: 'stopped', success: true },
    )
    // With the draft discarded, the folder reads the host copy again — and the
    // namespace root still answers with the folder itself.
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('file.list', { args: { path: 'work' }, runId })),
      {
        entries: [{ kind: 'file', name: 'original.txt' }],
        path: 'work',
        success: true,
        truncated: false,
      },
    )
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('file.list', { args: {}, runId })),
      {
        entries: [{ kind: 'directory', name: 'work' }],
        path: '.',
        success: true,
        truncated: false,
      },
    )
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('promotion remains unavailable without an owner-verified native helper', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-promotion-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-promotion-state-'))
  const runId = '00000000-0000-4000-8000-000000000207'
  const state = {
    apiBaseUrl: 'https://api.example.test',
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.write', 'workspace.promote'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000208',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceFolders: [{ name: 'work', path: root }],
  }
  try {
    await writeFile(join(root, 'original.txt'), 'base')
    await executeExecutorCommand(stateDir, state, commandFor('file.write', {
      args: { content: 'draft', overwrite: true, path: 'work/original.txt' },
      runId,
    }))
    const manifest = await promotionManifestForSandbox(stateDir, runId)
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('workspace.promote', {
        args: {
          approvalDigest: `sha256:${'0'.repeat(64)}`,
          manifestDigest: manifest.manifestDigest,
          promotionId: '00000000-0000-4000-8000-000000000209',
        },
        runId,
      })),
      { code: 'EXECUTOR_NATIVE_HELPER_UNAVAILABLE', success: false },
    )
    assert.equal(await readFile(join(root, 'original.txt'), 'utf8'), 'base')
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('a draft review digest binds file hashes even when byte counts do not change', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-manifest-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-manifest-state-'))
  const runId = '00000000-0000-4000-8000-000000000206'
  try {
    await writeFile(join(root, 'original.txt'), 'base')
    const folders = [{ name: 'work', path: root }]
    await writeSandboxFile(stateDir, folders, runId, {
      content: 'draft',
      overwrite: true,
      path: 'work/original.txt',
    })
    const first = await promotionManifestForSandbox(stateDir, runId)
    await writeSandboxFile(stateDir, folders, runId, {
      content: 'other',
      overwrite: true,
      path: 'work/original.txt',
    })
    const second = await promotionManifestForSandbox(stateDir, runId)
    assert.equal(first.changes[0]?.draft?.byteCount, second.changes[0]?.draft?.byteCount)
    assert.notEqual(first.manifestDigest, second.manifestDigest)
    assert.equal('draft' in first.changes[0]!, true)
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('daemon commands reject a missing server-provenanced run identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-daemon-invalid-source-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-daemon-invalid-state-'))
  const state = {
    apiBaseUrl: 'https://api.example.test',
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.write'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000205',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceFolders: [{ name: 'work', path: root }],
  }
  try {
    assert.deepEqual(
      await executeExecutorCommand(stateDir, state, commandFor('file.write', {
        args: { content: 'draft', path: 'work/draft.txt' },
      })),
      { code: 'EXECUTOR_COMMAND_RUN_INVALID', success: false },
    )
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})
