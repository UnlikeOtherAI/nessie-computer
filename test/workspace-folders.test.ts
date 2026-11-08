import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalExecutorJson, type ExecutorCommandEnvelope } from '@nessie/executor-protocol'
import { createHash } from 'node:crypto'

import { executeExecutorCommand } from '../src/daemon.js'
import { describeExecutor } from '../src/describe.js'
import { parseCommand } from '../src/cli-arguments.js'
import { configureExecutorLocalPolicy } from '../src/pair.js'
import {
  promotionManifestForSandbox,
  stopSandboxWorkspace,
  workspaceForRun,
  writeSandboxFile,
} from '../src/sandbox-workspace.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { loadExecutorState, saveExecutorState, type ExecutorLocalState } from '../src/state-store.js'
import {
  assertExecutorWorkspaceFolders,
  deriveExecutorWorkspaceFolderName,
  splitExecutorWorkspacePath,
  type ExecutorWorkspaceFolder,
} from '../src/workspace-folders.js'
import { listWorkspaceFiles, readWorkspaceFile } from '../src/workspace.js'
import type { ExecutorHost } from '../src/host-platform.js'
import { WINDOWS_STATE_HELPER_SKIP, WINDOWS_SYMLINK_SKIP } from './windows-prerequisites.js'

const sandboxHost: ExecutorHost = {
  platform: { architecture: 'arm64', os: 'macos', osMajorVersion: 15 },
  sandboxBackend: 'virtualization_framework',
  supervisor: 'desktop',
}

const commandFor = (
  operationKey: ExecutorCommandEnvelope['operationKey'],
  payload: Record<string, unknown>,
): ExecutorCommandEnvelope => ({
  argumentDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}` as never,
  bindingFence: '1',
  bindingId: '00000000-0000-4000-8000-000000000301' as never,
  capabilityRevision: 1,
  commandId: '00000000-0000-4000-8000-000000000302' as never,
  expiresAt: '2099-08-12T12:00:00.000Z',
  idempotencyKey: 'executor-folder-test',
  operationKey,
  payload,
})

const hostView = (...folders: ExecutorWorkspaceFolder[]) => ({
  directoryFor: async (folder: ExecutorWorkspaceFolder) => folder.path,
  folders,
})

const stateFor = (
  folders: ExecutorWorkspaceFolder[],
  operationKeys = ['file.list', 'file.read', 'file.write', 'workspace.review', 'sandbox.stop'],
): ExecutorLocalState => ({
  apiBaseUrl: 'https://api.example.test',
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys,
    profiles: ['workspace_sandbox'],
    revision: 1,
    workspaceFolders: folders.map((folder) => folder.name).sort(),
  },
  executorId: '00000000-0000-4000-8000-000000000303',
  machinePrivateKey: 'private',
  machinePublicKey: 'public',
  workspaceFolders: folders,
})

/** Two paired folders plus a directory that is paired to neither. */
const twoFolders = async (label: string) => {
  const root = await mkdtemp(join(tmpdir(), `nessie-executor-${label}-`))
  const alpha = join(root, 'alpha')
  const beta = join(root, 'beta')
  const unpaired = join(root, 'unpaired')
  await Promise.all([mkdir(alpha), mkdir(beta), mkdir(unpaired)])
  await writeFile(join(alpha, 'public.txt'), 'alpha public')
  await writeFile(join(beta, 'secret'), 'beta secret')
  await writeFile(join(unpaired, 'secret'), 'unpaired secret')
  return {
    alpha,
    beta,
    folders: [{ name: 'alpha', path: alpha }, { name: 'beta', path: beta }],
    root,
    unpaired,
  }
}

test('the folder name grammar refuses every shape that could be mistaken for a path', () => {
  for (const name of [
    '', '.', '..', '...', '-lead', 'trail-', 'Upper', 'has space', 'has/slash', 'has\\\\slash',
    'con', 'nul', 'com1', 'lpt9', 'a'.repeat(41), 'ünïcode', 'under_score', 'dot.name',
  ]) {
    assert.throws(
      () => assertExecutorWorkspaceFolders([{ name, path: '/tmp/x' }]),
      /workspace folder name is 1 to 40/,
      `"${name}" must be refused`,
    )
  }
  for (const name of ['a', 'a1', 'nessie', 'nessie-monorepo', '9lives', 'a'.repeat(40)]) {
    assert.deepEqual(
      assertExecutorWorkspaceFolders([{ name, path: '/tmp/x' }]),
      [{ name, path: '/tmp/x' }],
    )
  }
})

test('a folder set refuses duplicate names and folders that contain each other', () => {
  assert.throws(
    () => assertExecutorWorkspaceFolders([
      { name: 'one', path: '/tmp/a' },
      { name: 'one', path: '/tmp/b' },
    ]),
    /named once/,
  )
  assert.throws(
    () => assertExecutorWorkspaceFolders([
      { name: 'outer', path: '/tmp/a' },
      { name: 'inner', path: '/tmp/a/inner' },
    ]),
    /one file would have two names/,
  )
  assert.throws(
    () => assertExecutorWorkspaceFolders([
      { name: 'one', path: '/tmp/a' },
      { name: 'two', path: '/tmp/a' },
    ]),
    /one file would have two names/,
  )
  assert.throws(() => assertExecutorWorkspaceFolders([]), /at least one workspace folder/)
  assert.throws(
    () => assertExecutorWorkspaceFolders(
      Array.from({ length: 17 }, (_value, index) => ({ name: `f${index}`, path: `/tmp/f${index}` })),
    ),
    /at most 16 workspace folders/,
  )
})

test('a workspace path splits into its folder and the path beneath it', () => {
  assert.deepEqual(splitExecutorWorkspacePath(undefined), { path: '.' })
  assert.deepEqual(splitExecutorWorkspacePath('  '), { path: '.' })
  assert.deepEqual(splitExecutorWorkspacePath('.'), { path: '.' })
  assert.deepEqual(splitExecutorWorkspacePath('nessie'), { folderName: 'nessie', path: '.' })
  assert.deepEqual(splitExecutorWorkspacePath('nessie/api/src/index.ts'), {
    folderName: 'nessie',
    path: 'api/src/index.ts',
  })
  assert.deepEqual(splitExecutorWorkspacePath('nessie\\\\api\\\\index.ts'), {
    folderName: 'nessie',
    path: 'api/index.ts',
  })
  for (const path of ['../other/secret', 'nessie/../other/secret', 'nessie/..', '..']) {
    assert.throws(() => splitExecutorWorkspacePath(path), /may not contain "\.\."/)
  }
  for (const path of ['/etc/passwd', '\\\\etc\\\\passwd', 'C:\\\\Users\\\\someone', 'c:/Users/someone', 'D:relative']) {
    assert.throws(() => splitExecutorWorkspacePath(path), /must be relative/)
  }
  assert.throws(() => splitExecutorWorkspacePath('nes\0sie/x'), /NUL/)
})

test('a read may not leave its folder, reach another folder, or reach an unpaired directory', async () => {
  const fixture = await twoFolders('folder-escape')
  const view = hostView(...fixture.folders)
  try {
    // The honest read works, and answers with the path the agent wrote.
    assert.deepEqual(await readWorkspaceFile(view, { path: 'alpha/public.txt' }), {
      byteCount: 12,
      content: 'alpha public',
      path: 'alpha/public.txt',
      success: true,
      truncated: false,
    })

    // `..` climbing out of one folder into its sibling.
    await assert.rejects(
      readWorkspaceFile(view, { path: 'alpha/../beta/secret' }),
      /may not contain "\.\."/,
    )
    // The same escape spelled with Windows separators.
    await assert.rejects(
      readWorkspaceFile(view, { path: 'alpha\\\\..\\\\beta\\\\secret' }),
      /may not contain "\.\."/,
    )
    // `..` climbing out of the namespace altogether.
    await assert.rejects(
      readWorkspaceFile(view, { path: '../unpaired/secret' }),
      /may not contain "\.\."/,
    )
    // An absolute host path, including one that names a real paired folder.
    await assert.rejects(readWorkspaceFile(view, { path: fixture.beta }), /must be relative/)

    // A first segment that is not a folder: legal name, no such folder.
    await assert.rejects(
      readWorkspaceFile(view, { path: 'gamma/secret' }),
      /No workspace folder is named "gamma"\. Reachable folders: alpha, beta\./,
    )
    // A first segment that is not even a legal name.
    await assert.rejects(
      readWorkspaceFile(view, { path: 'Beta/secret' }),
      /workspace folder name is 1 to 40/,
    )
    // A folder alone is a directory, not a file.
    await assert.rejects(readWorkspaceFile(view, { path: 'alpha' }), /names a folder and a file/)
  } finally {
    await rm(fixture.root, { force: true, recursive: true })
  }
})

test('a symbolic link inside one folder cannot be followed into another folder', { skip: WINDOWS_SYMLINK_SKIP }, async () => {
  const fixture = await twoFolders('folder-symlink')
  const view = hostView(...fixture.folders)
  try {
    await symlink(join(fixture.beta, 'secret'), join(fixture.alpha, 'beta-secret'))
    await symlink(fixture.beta, join(fixture.alpha, 'beta-dir'))
    await symlink(join(fixture.unpaired, 'secret'), join(fixture.alpha, 'unpaired-secret'))

    // Proof the link really does point at the other folder's bytes.
    assert.equal(await readFile(join(fixture.alpha, 'beta-secret'), 'utf8'), 'beta secret')

    for (const path of ['alpha/beta-secret', 'alpha/beta-dir/secret', 'alpha/unpaired-secret']) {
      await assert.rejects(readWorkspaceFile(view, { path }), /symbolic links|not a regular file/)
    }
    // A listing hides the links rather than resolving them.
    assert.deepEqual(await listWorkspaceFiles(view, { path: 'alpha' }), {
      entries: [{ kind: 'file', name: 'public.txt' }],
      path: 'alpha',
      success: true,
      truncated: false,
    })
  } finally {
    await rm(fixture.root, { force: true, recursive: true })
  }
})

test('a write reaches only its own folder and snapshots only that folder', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const fixture = await twoFolders('folder-write')
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-folder-write-state-'))
  const runId = '00000000-0000-4000-8000-000000000311'
  try {
    assert.deepEqual(
      await writeSandboxFile(stateDir, fixture.folders, runId, {
        content: 'draft',
        createParents: true,
        path: 'alpha/notes/draft.txt',
      }),
      { byteCount: 5, path: 'alpha/notes/draft.txt', success: true },
    )
    await assert.rejects(
      writeSandboxFile(stateDir, fixture.folders, runId, {
        content: 'escape',
        path: 'alpha/../beta/planted.txt',
      }),
      /may not contain "\.\."/,
    )
    await assert.rejects(
      writeSandboxFile(stateDir, fixture.folders, runId, {
        content: 'escape',
        path: 'gamma/planted.txt',
      }),
      /No workspace folder is named "gamma"/,
    )

    // Nothing was written to any host folder, and only `alpha` was snapshotted.
    await assert.rejects(readFile(join(fixture.alpha, 'notes', 'draft.txt'), 'utf8'), { code: 'ENOENT' })
    await assert.rejects(readFile(join(fixture.beta, 'planted.txt'), 'utf8'), { code: 'ENOENT' })
    const alphaDraft = await workspaceForRun(stateDir, fixture.folders[0]!, runId)
    const betaDraft = await workspaceForRun(stateDir, fixture.folders[1]!, runId)
    assert.notEqual(alphaDraft, await realpath(fixture.alpha))
    assert.equal(betaDraft, await realpath(fixture.beta), 'an untouched folder still reads the host copy')

    // The run's review names the folder of every change.
    const manifest = await promotionManifestForSandbox(stateDir, runId)
    assert.deepEqual(manifest.changes.map((change) => change.path), ['alpha/notes/draft.txt'])
    assert.deepEqual(manifest.folders.map((folder) => folder.name), ['alpha'])
    assert.deepEqual(manifest.folders[0]?.changes.map((change) => change.path), ['notes/draft.txt'])
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(fixture.root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('a review across two folders is folder-qualified and refuses one-folder promotion', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const fixture = await twoFolders('folder-review')
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-folder-review-state-'))
  const runId = '00000000-0000-4000-8000-000000000312'
  const state = stateFor(fixture.folders, ['file.write', 'workspace.review', 'workspace.promote'])
  try {
    for (const path of ['alpha/one.txt', 'beta/two.txt']) {
      assert.equal(
        (await executeExecutorCommand(stateDir, state, commandFor('file.write', {
          args: { content: 'draft', path },
          runId,
        }))).success,
        true,
      )
    }
    const review = await executeExecutorCommand(stateDir, state, commandFor('workspace.review', {
      args: {},
      runId,
    }))
    assert.deepEqual(review.changes, [
      { byteCount: 5, kind: 'created', path: 'alpha/one.txt' },
      { byteCount: 5, kind: 'created', path: 'beta/two.txt' },
    ])
    const promotion = await executeExecutorCommand(stateDir, state, commandFor('workspace.promote', {
      args: {
        approvalDigest: `sha256:${'0'.repeat(64)}`,
        manifestDigest: review.manifestDigest,
        promotionId: '00000000-0000-4000-8000-000000000313',
      },
      runId,
    }))
    assert.deepEqual(promotion, {
      code: 'EXECUTOR_PROMOTION_SINGLE_FOLDER_REQUIRED',
      folders: ['alpha', 'beta'],
      message: 'This review changed more than one workspace folder, and promotion applies one.',
      success: false,
    })
  } finally {
    await rm(fixture.root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('a guest session refuses to start while more than one folder is configured', async () => {
  const fixture = await twoFolders('folder-guest')
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-folder-guest-state-'))
  const state = stateFor(fixture.folders, ['command.run', 'coding.launch', 'browser.open'])
  try {
    for (const [operationKey, args] of [
      ['command.run', { args: [], program: 'git' }],
      ['coding.launch', { prompt: 'do the thing' }],
      ['browser.open', { url: 'https://example.test/' }],
    ] as const) {
      assert.deepEqual(
        await executeExecutorCommand(
          stateDir,
          { ...state, descriptor: { ...state.descriptor, commandAllowlist: ['git'] } },
          commandFor(operationKey, { args, runId: '00000000-0000-4000-8000-000000000314' }),
        ),
        {
          code: 'EXECUTOR_GUEST_SINGLE_FOLDER_REQUIRED',
          folders: ['alpha', 'beta'],
          message:
            'A guest session mounts one folder, and this team uses 2. '
            + 'The workspace file operations reach every folder.',
          success: false,
        },
        operationKey,
      )
    }
    // The same executor still reaches every folder through the file operations.
    assert.deepEqual(
      await executeExecutorCommand(
        stateDir,
        stateFor(fixture.folders),
        commandFor('file.list', { args: {}, runId: '00000000-0000-4000-8000-000000000315' }),
      ),
      {
        entries: [{ kind: 'directory', name: 'alpha' }, { kind: 'directory', name: 'beta' }],
        path: '.',
        success: true,
        truncated: false,
      },
    )
  } finally {
    await rm(fixture.root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})

test('a state file written before folders had names keeps working', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-executor-folder-legacy-'))
  const stateDir = join(root, 'state')
  const workspace = join(root, 'Projects')
  const runId = '00000000-0000-4000-8000-000000000316'
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'README.txt'), 'legacy')
  // Exactly the shape the previous version wrote, including the absent
  // `descriptor.workspaceFolders` that keeps its signed descriptor unchanged.
  const legacy = {
    apiBaseUrl: 'https://api.example.test',
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.list', 'file.read', 'file.write', 'workspace.review', 'sandbox.stop'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000317',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceRoot: workspace,
  }
  try {
    // Written the way the previous binary wrote it, not through the current
    // save path: this is a file that already exists on somebody's machine.
    // On Windows that binary secured the directory through the helper too.
    if (process.platform === 'win32') await ensureOwnerOnlyStateDirectory(stateDir)
    else await mkdir(stateDir, { mode: 0o700 })
    await writeFile(join(stateDir, 'executor-state.json'), `${JSON.stringify(legacy)}\n`, { mode: 0o600 })
    const loaded = await loadExecutorState(stateDir)
    assert.deepEqual(loaded.workspaceFolders, [{ name: 'projects', path: workspace }])
    assert.equal('workspaceRoot' in loaded, false)
    assert.equal(loaded.descriptor.workspaceFolders, undefined)
    assert.equal(describeExecutor(loaded).reach.guestSessions, 'available')

    // The derived name is the one an agent uses, immediately.
    assert.deepEqual(
      await executeExecutorCommand(stateDir, loaded, commandFor('file.read', {
        args: { path: 'projects/README.txt' },
        runId,
      })),
      {
        byteCount: 6,
        content: 'legacy',
        path: 'projects/README.txt',
        success: true,
        truncated: false,
      },
    )

    // The first proposed policy is what names the folders in the descriptor.
    const configured = await configureExecutorLocalPolicy(
      stateDir,
      loaded,
      ['file.list', 'file.read'],
      undefined,
      sandboxHost,
    )
    assert.deepEqual(configured.descriptor.workspaceFolders, ['projects'])
    assert.equal(configured.descriptor.revision, 2)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('the derived name is total, and falls back rather than producing an illegal one', () => {
  assert.equal(deriveExecutorWorkspaceFolderName('/Users/me/Projects/nessie'), 'nessie')
  assert.equal(deriveExecutorWorkspaceFolderName('/Users/me/My Notes'), 'my-notes')
  assert.equal(deriveExecutorWorkspaceFolderName('C:\\\\Users\\\\me\\\\Code'), 'code')
  assert.equal(deriveExecutorWorkspaceFolderName('/'), 'workspace')
  assert.equal(deriveExecutorWorkspaceFolderName('/Users/me/...'), 'workspace')
  assert.equal(deriveExecutorWorkspaceFolderName('/Users/me/κόσμος'), 'workspace')
  // A reserved Windows device name must not survive the derivation.
  assert.equal(deriveExecutorWorkspaceFolderName('/Users/me/con'), 'workspace')
  // A long basename is truncated, and never to a trailing hyphen.
  assert.equal(deriveExecutorWorkspaceFolderName(`/x/${'a'.repeat(60)}`), 'a'.repeat(40))
  assert.equal(deriveExecutorWorkspaceFolderName(`/x/${'b'.repeat(40)} tail`), 'b'.repeat(40))
})

test('the CLI names folders on the command line and over standard input', () => {
  assert.deepEqual(
    parseCommand([
      'configure',
      '--state-dir', '/private/tmp/nessie-executor',
      '--operations', 'file.list,file.read',
      '--folder', 'nessie=/Users/me/Projects/nessie',
      '--folder', 'notes=/Users/me/Notes',
    ]),
    {
      kind: 'configure',
      operationKeys: ['file.list', 'file.read'],
      stateDir: '/private/tmp/nessie-executor',
      workspaceFolders: [
        { name: 'nessie', path: '/Users/me/Projects/nessie' },
        { name: 'notes', path: '/Users/me/Notes' },
      ],
    },
  )
  // `--workspace` is the single-folder spelling the desktop app still uses.
  assert.deepEqual(
    parseCommand([
      'configure',
      '--state-dir', '/private/tmp/nessie-executor',
      '--operations', 'file.list',
      '--workspace', '/Users/me/Projects/nessie',
    ]).workspaceFolders,
    [{ name: 'nessie', path: '/Users/me/Projects/nessie' }],
  )
  // Naming folders and giving a single one are opposite instructions.
  assert.throws(
    () => parseCommand([
      'configure', '--state-dir', '/s', '--operations', 'file.list',
      '--workspace', '/a', '--folder', 'b=/b',
    ]),
    /Name the workspace folders with --folder/,
  )
  assert.throws(
    () => parseCommand([
      'configure', '--state-dir', '/s', '--operations', 'file.list', '--folder', '/no-name',
    ]),
    /--folder needs <name>=<absolute-path>/,
  )
  // A host path containing `=` survives, because only the first one splits.
  assert.deepEqual(
    parseCommand([
      'configure', '--state-dir', '/s', '--operations', 'file.list',
      '--folder', 'odd=/Users/me/a=b',
    ]).workspaceFolders,
    [{ name: 'odd', path: '/Users/me/a=b' }],
  )
  // Omitting both keeps the folders the policy already has.
  assert.equal(
    parseCommand(['configure', '--state-dir', '/s', '--operations', 'file.list']).workspaceFolders,
    undefined,
  )
})

test('a configured folder set is refused while a draft or sandbox exists', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const fixture = await twoFolders('folder-frozen')
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-executor-folder-frozen-state-'))
  const runId = '00000000-0000-4000-8000-000000000318'
  const state = stateFor([fixture.folders[0]!])
  try {
    await saveExecutorState(stateDir, state)
    await writeSandboxFile(stateDir, state.workspaceFolders, runId, {
      content: 'draft',
      path: 'alpha/draft.txt',
    })
    await assert.rejects(
      configureExecutorLocalPolicy(
        stateDir,
        state,
        ['file.list', 'file.read'],
        undefined,
        sandboxHost,
        fixture.folders,
      ),
      /Remove every local draft and stop every sandbox/,
    )
    // Restating the same folders is not a change, so it is allowed.
    const kept = await configureExecutorLocalPolicy(
      stateDir,
      state,
      ['file.list', 'file.read'],
      undefined,
      sandboxHost,
      state.workspaceFolders,
    )
    assert.deepEqual(kept.workspaceFolders, state.workspaceFolders)
    assert.equal(await stopSandboxWorkspace(stateDir, runId), true)
  } finally {
    await rm(fixture.root, { force: true, recursive: true })
    await rm(stateDir, { force: true, recursive: true })
  }
})
