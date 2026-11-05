import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  createDeepTestSourceAdapter,
  serializeDeepTestSourceResponse,
  serveDeepTestSourceAdapter,
} from '../src/deeptest-source-adapter.js'
import { parseDeepTestSourceRequest } from '../src/deeptest-source-protocol.js'
import type { ExecutorLocalState } from '../src/state-store.js'
import { parseCommand } from '../src/cli-arguments.js'

const execFileAsync = promisify(execFile)

const binding = {
  account_id: 'account_00000000-0000-4000-8000-000000000001',
  project_id: 'project_00000000-0000-4000-8000-000000000002',
  review_id: 'review_00000000-0000-4000-8000-000000000003',
  session_id: 'session_00000000-0000-4000-8000-000000000004',
} as const

const request = (operation: string, extra: Record<string, unknown> = {}) => ({
  ...binding,
  operation,
  protocol_version: 1,
  request_id: `request_${operation.replace('.', '_')}`,
  ...extra,
})

const snapshotRequest = async (root: string, extra: Record<string, unknown> = {}) => request(
  'source.snapshot',
  {
    expected_commit: await git(root, ['rev-parse', 'HEAD']),
    expected_source_root: root,
    ...extra,
  },
)

const stateFor = (workspaceRoot: string, operationKeys = ['file.list', 'file.read']): ExecutorLocalState => ({
  apiBaseUrl: 'https://api.nessie.example',
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys,
    profiles: ['workspace_sandbox'],
    revision: 1,
  },
  executorId: '00000000-0000-4000-8000-000000000005',
  machinePrivateKey: 'private',
  machinePublicKey: 'public',
  workspaceFolders: [{ name: 'workspace', path: workspaceRoot }],
})

const git = async (root: string, args: string[]): Promise<string> => {
  const result = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  })
  return result.stdout.trim()
}

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-deeptest-source-'))
  await git(root, ['init', '--quiet'])
  await git(root, ['config', 'user.email', 'fixture@example.test'])
  await git(root, ['config', 'user.name', 'Fixture'])
  await writeFile(join(root, 'app.ts'), 'export const answer = 42\n')
  await git(root, ['add', 'app.ts'])
  await git(root, ['commit', '--quiet', '-m', 'fixture'])
  return root
}

test('DeepTest native source command is a packaged executor entry point', () => {
  assert.deepEqual(
    parseCommand(['deeptest-source', '--source-grant-file', '/private/nessie/deeptest-source-grant.json']),
    { kind: 'deeptest-source', sourceGrantFile: '/private/nessie/deeptest-source-grant.json' },
  )
  assert.throws(() => parseCommand(['deeptest-source']), /source-grant-file/u)
  assert.deepEqual(
    parseCommand(['publish-deeptest-source-grant', '--state-dir', '/private/nessie/executor']),
    { kind: 'publish-deeptest-source-grant', stateDir: '/private/nessie/executor' },
  )
})

test('protocol parsing rejects extra keys, unbounded pages, and malformed identities', () => {
  assert.equal(parseDeepTestSourceRequest(request('hello')).operation, 'hello')
  assert.equal(parseDeepTestSourceRequest({ ...request('hello'), account_id: 'account.example' }).account_id, 'account.example')
  assert.throws(
    () => parseDeepTestSourceRequest({ ...request('hello'), workspace: '/outside' }),
    /REQUEST_INVALID/u,
  )
  assert.throws(
    () => parseDeepTestSourceRequest(request('source.inventory', {
      max_entries: 501,
      snapshot_id: '00000000-0000-4000-8000-000000000006',
    })),
    /REQUEST_INVALID/u,
  )
  assert.throws(
    () => parseDeepTestSourceRequest({ ...request('hello'), account_id: '../another-account' }),
    /REQUEST_INVALID/u,
  )
  assert.throws(
    () => parseDeepTestSourceRequest(request('source.read', {
      paths: ['../outside'],
      snapshot_id: '00000000-0000-4000-8000-000000000006',
    })),
    /REQUEST_INVALID/u,
  )
})

test('serialized output supports one worst-case file and returns a typed limit for larger frames', () => {
  const envelope = (content: string) => ({
    protocol_version: 1 as const,
    request_id: 'output_limit',
    result: { content },
    status: 'ok' as const,
  })
  const oneFile = serializeDeepTestSourceResponse(envelope('\u0001'.repeat(2 * 1024 * 1024)))
  assert.equal(JSON.parse(oneFile).status, 'ok')
  const tooLarge = serializeDeepTestSourceResponse(envelope('\u0001'.repeat(4 * 1024 * 1024)))
  const parsed = JSON.parse(tooLarge) as { result: { code: string }; status: string }
  assert.equal(Buffer.byteLength(tooLarge, 'utf8') < 1024, true)
  assert.equal(parsed.status, 'incomplete')
  assert.equal(parsed.result.code, 'OUTPUT_BYTES_LIMIT')
})

test('adapter pins source bytes and rejects another account, project, review, or snapshot', async () => {
  const root = await repository()
  try {
    const adapter = createDeepTestSourceAdapter(stateFor(root))
    const hello = await adapter.dispatch(request('hello'))
    assert.equal(hello.status, 'ok')
    assert.deepEqual(
      hello.status === 'error' ? [] : hello.result.capabilities,
      ['source.snapshot', 'source.inventory', 'source.read', 'source.release'],
    )
    const opened = await adapter.dispatch(await snapshotRequest(root))
    if (opened.status === 'error') assert.fail(JSON.stringify(opened))
    assert.equal(opened.status, 'ok')
    const snapshotId = String(opened.result.snapshot_id)
    assert.match(snapshotId, /^[0-9a-f-]{36}$/u)
    assert.match(String(opened.result.manifest_digest), /^sha256:[0-9a-f]{64}$/u)
    assert.equal(opened.result.working_tree_state, 'clean')

    const duplicate = await adapter.dispatch(await snapshotRequest(root))
    assert.equal(duplicate.status, 'error')
    if (duplicate.status !== 'error') assert.fail('Expected a snapshot limit refusal.')
    assert.equal(duplicate.error.code, 'SNAPSHOT_LIMIT')

    await writeFile(join(root, 'app.ts'), 'export const answer = 7\n')
    const read = await adapter.dispatch(request('source.read', {
      paths: ['app.ts'],
      snapshot_id: snapshotId,
    }))
    assert.equal(read.status, 'ok')
    if (read.status === 'error') assert.fail(read.error.message)
    const readFiles = read.result.files as Array<Record<string, unknown>>
    assert.equal(readFiles.length, 1)
    assert.deepEqual(readFiles[0], {
      bytes: 25,
      content: 'export const answer = 42\n',
      digest: readFiles[0]?.digest,
      path: 'app.ts',
      reason: null,
      status: 'readable',
    })
    assert.match(String(readFiles[0]?.digest), /^sha256:/u)

    const wrongAccount = await adapter.dispatch({
      ...request('source.inventory', { snapshot_id: snapshotId }),
      account_id: 'account_00000000-0000-4000-8000-000000000099',
    })
    assert.equal(wrongAccount.status, 'error')
    if (wrongAccount.status !== 'error') assert.fail('Expected a binding refusal.')
    assert.equal(wrongAccount.error.code, 'BINDING_MISMATCH')

    const wrongSnapshot = await adapter.dispatch(request('source.inventory', {
      snapshot_id: '00000000-0000-4000-8000-000000000099',
    }))
    assert.equal(wrongSnapshot.status, 'error')
    if (wrongSnapshot.status !== 'error') assert.fail('Expected a missing snapshot refusal.')
    assert.equal(wrongSnapshot.error.code, 'SNAPSHOT_NOT_FOUND')

    const released = await adapter.dispatch(request('source.release', { snapshot_id: snapshotId }))
    assert.equal(released.status, 'ok')
    assert.equal(adapter.snapshotCount(), 0)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('empty committed repositories produce a complete empty inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-deeptest-empty-'))
  try {
    await git(root, ['init', '--quiet'])
    await git(root, ['config', 'user.email', 'fixture@example.test'])
    await git(root, ['config', 'user.name', 'Fixture'])
    await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'empty'])
    const adapter = createDeepTestSourceAdapter(stateFor(root))
    await adapter.dispatch(request('hello'))
    const opened = await adapter.dispatch(await snapshotRequest(root))
    assert.equal(opened.status, 'ok')
    if (opened.status === 'error') assert.fail(opened.error.message)
    assert.deepEqual(opened.result.coverage, {
      complete: true,
      excluded_bytes: 0,
      excluded_files: 0,
      readable_bytes: 0,
      readable_files: 0,
      working_tree_changes_excluded: false,
    })
    const inventory = await adapter.dispatch(request('source.inventory', {
      snapshot_id: String(opened.result.snapshot_id),
    }))
    if (inventory.status === 'error') assert.fail(inventory.error.message)
    assert.deepEqual(inventory.result.entries, [])
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('tracked non-UTF-8 text is explicitly excluded instead of replacement-decoded', async () => {
  const root = await repository()
  try {
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0x61, 0xc3, 0x28, 0x62]))
    await git(root, ['add', 'invalid.txt'])
    await git(root, ['commit', '--quiet', '-m', 'invalid utf8'])
    const adapter = createDeepTestSourceAdapter(stateFor(root))
    await adapter.dispatch(request('hello'))
    const opened = await adapter.dispatch(await snapshotRequest(root))
    assert.equal(opened.status, 'incomplete')
    if (opened.status === 'error') assert.fail(opened.error.message)
    const inventory = await adapter.dispatch(request('source.inventory', {
      snapshot_id: String(opened.result.snapshot_id),
    }))
    if (inventory.status === 'error') assert.fail(inventory.error.message)
    const invalid = (inventory.result.entries as Array<{ path: string; reason: string | null }>)
      .find((entry) => entry.path === 'invalid.txt')
    assert.equal(invalid?.reason, 'content_not_utf8')
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('inventory reports every excluded tracked entry and never presents partial coverage as complete', async () => {
  const root = await repository()
  try {
    await writeFile(join(root, 'binary.bin'), Buffer.from([1, 0, 2]))
    await writeFile(join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
    await git(root, ['add', 'binary.bin', 'large.txt'])
    const targetBlob = await git(root, ['hash-object', '-w', 'app.ts'])
    await git(root, ['update-index', '--add', '--cacheinfo', `120000,${targetBlob},linked-source`])
    await git(root, ['commit', '--quiet', '-m', 'excluded fixtures'])

    const adapter = createDeepTestSourceAdapter(stateFor(root))
    await adapter.dispatch(request('hello'))
    const opened = await adapter.dispatch(await snapshotRequest(root))
    if (opened.status === 'error') assert.fail(JSON.stringify(opened))
    assert.equal(opened.status, 'incomplete')
    const snapshotId = String(opened.result.snapshot_id)
    assert.deepEqual(opened.result.coverage, {
      complete: false,
      excluded_bytes: 2 * 1024 * 1024 + 29,
      excluded_files: 3,
      readable_bytes: 25,
      readable_files: 1,
      working_tree_changes_excluded: true,
    })

    const first = await adapter.dispatch(request('source.inventory', {
      max_entries: 2,
      snapshot_id: snapshotId,
    }))
    assert.equal(first.status, 'incomplete')
    if (first.status === 'error') assert.fail(first.error.message)
    assert.equal((first.result.entries as unknown[]).length, 2)
    assert.equal(first.result.next_cursor, '2')
    const second = await adapter.dispatch(request('source.inventory', {
      cursor: String(first.result.next_cursor),
      max_entries: 2,
      snapshot_id: snapshotId,
    }))
    if (second.status === 'error') assert.fail(second.error.message)
    const entries = [
      ...(first.result.entries as Array<{ path: string; reason: string | null }>),
      ...(second.result.entries as Array<{ path: string; reason: string | null }>),
    ]
    assert.deepEqual(
      entries.map(({ path, reason }) => [path, reason]),
      [
        ['app.ts', null],
        ['binary.bin', 'binary_file'],
        ['large.txt', 'file_too_large'],
        ['linked-source', 'symbolic_link'],
      ],
    )
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('adapter refuses stale commits and missing local read permissions', async () => {
  const root = await repository()
  try {
    const denied = createDeepTestSourceAdapter(stateFor(root, ['file.read']))
    const unavailable = await denied.dispatch(request('hello'))
    assert.equal(unavailable.status, 'error')
    if (unavailable.status !== 'error') assert.fail('Expected capability refusal.')
    assert.equal(unavailable.error.code, 'CAPABILITY_UNAVAILABLE')

    const adapter = createDeepTestSourceAdapter(stateFor(root))
    await adapter.dispatch(request('hello'))
    const mismatch = await adapter.dispatch(request('source.snapshot', {
      expected_commit: '0'.repeat(40),
      expected_source_root: root,
    }))
    assert.equal(mismatch.status, 'error')
    if (mismatch.status !== 'error') assert.fail('Expected commit refusal.')
    assert.equal(mismatch.error.code, 'COMMIT_MISMATCH')
    assert.equal(adapter.snapshotCount(), 0)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('dirty working-tree state is disclosed while the explicitly pinned commit stays complete', async () => {
  const root = await repository()
  try {
    const commit = await git(root, ['rev-parse', 'HEAD'])
    await writeFile(join(root, 'app.ts'), 'uncommitted bytes\n')

    const defaultAdapter = createDeepTestSourceAdapter(stateFor(root))
    await defaultAdapter.dispatch(request('hello'))
    const defaultSnapshot = await defaultAdapter.dispatch(await snapshotRequest(root))
    assert.equal(defaultSnapshot.status, 'ok')
    if (defaultSnapshot.status === 'error') assert.fail(defaultSnapshot.error.message)
    assert.deepEqual(defaultSnapshot.result.coverage, {
      complete: true,
      excluded_bytes: 0,
      excluded_files: 0,
      readable_bytes: 25,
      readable_files: 1,
      working_tree_changes_excluded: true,
    })

    const pinnedAdapter = createDeepTestSourceAdapter(stateFor(root))
    await pinnedAdapter.dispatch(request('hello'))
    const pinnedSnapshot = await pinnedAdapter.dispatch(request('source.snapshot', {
      expected_commit: commit,
      expected_source_root: root,
    }))
    assert.equal(pinnedSnapshot.status, 'ok')
    if (pinnedSnapshot.status === 'error') assert.fail(pinnedSnapshot.error.message)
    assert.deepEqual(pinnedSnapshot.result.coverage, {
      complete: true,
      excluded_bytes: 0,
      excluded_files: 0,
      readable_bytes: 25,
      readable_files: 1,
      working_tree_changes_excluded: true,
    })
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('EOF clears every in-memory snapshot and the adapter has no Nessie command-result transport', async () => {
  const root = await repository()
  try {
    const state = stateFor(root)
    const lines = [request('hello'), await snapshotRequest(root)]
      .map((frame) => JSON.stringify(frame))
      .join('\n')
    let output = ''
    await serveDeepTestSourceAdapter(
      state,
      Readable.from([lines]),
      new Writable({
        write(chunk, _encoding, callback) {
          output += chunk.toString()
          callback()
        },
      }),
    )
    const responses = output.trim().split('\n').map((line) => JSON.parse(line) as { status: string })
    assert.deepEqual(responses.map(({ status }) => status), ['ok', 'error'])

    const source = await readFile(new URL('../src/deeptest-source-adapter.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /api-client|recordCommandReceipt|executorApi/u)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('a crafted Git pointer cannot escape the approved Nessie workspace', async () => {
  const outside = await repository()
  const allowed = await mkdtemp(join(tmpdir(), 'nessie-deeptest-pointer-'))
  try {
    await writeFile(join(allowed, '.git'), `gitdir: ${join(outside, '.git')}\n`)
    const adapter = createDeepTestSourceAdapter(stateFor(allowed))
    await adapter.dispatch(request('hello'))
    const opened = await adapter.dispatch(request('source.snapshot', {
      expected_commit: '0'.repeat(40),
      expected_source_root: allowed,
    }))
    assert.equal(opened.status, 'error')
    if (opened.status !== 'error') assert.fail('Expected Git layout refusal.')
    assert.equal(opened.error.code, 'GIT_LAYOUT_UNSUPPORTED')
  } finally {
    await rm(allowed, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  }
})

test('an outside object database cannot supply a blob through alternates', async () => {
  const outside = await repository()
  const allowed = await repository()
  try {
    await writeFile(join(outside, 'outside.txt'), 'outside secret bytes\n')
    const oid = await git(outside, ['hash-object', '-w', 'outside.txt'])
    const alternates = join(allowed, '.git', 'objects', 'info', 'alternates')
    await writeFile(alternates, `${join(outside, '.git', 'objects')}\n`)
    await git(allowed, ['update-index', '--add', '--cacheinfo', `100644,${oid},outside.txt`])
    await git(allowed, ['commit', '--quiet', '-m', 'outside object'])

    const adapter = createDeepTestSourceAdapter(stateFor(allowed))
    await adapter.dispatch(request('hello'))
    const opened = await adapter.dispatch(await snapshotRequest(allowed))
    assert.equal(opened.status, 'error')
    if (opened.status !== 'error') assert.fail('Expected alternate object database refusal.')
    assert.equal(opened.error.code, 'GIT_LAYOUT_UNSUPPORTED')
  } finally {
    await rm(allowed, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  }
})

test('a linked loose-object directory cannot expose an outside blob', async (context) => {
  const outside = await repository()
  const allowed = await repository()
  try {
    await writeFile(join(outside, 'outside.txt'), 'outside linked bytes\n')
    const oid = await git(outside, ['hash-object', '-w', 'outside.txt'])
    const alternates = join(allowed, '.git', 'objects', 'info', 'alternates')
    await writeFile(alternates, `${join(outside, '.git', 'objects')}\n`)
    await git(allowed, ['update-index', '--add', '--cacheinfo', `100644,${oid},outside.txt`])
    await git(allowed, ['commit', '--quiet', '-m', 'outside linked object'])
    await rm(alternates)
    const prefix = join(allowed, '.git', 'objects', oid.slice(0, 2))
    await rm(prefix, { force: true, recursive: true })
    try {
      await symlink(
        join(outside, '.git', 'objects', oid.slice(0, 2)),
        prefix,
        process.platform === 'win32' ? 'junction' : 'dir',
      )
    } catch {
      context.skip('This account cannot create the object-directory link fixture.')
      return
    }

    const adapter = createDeepTestSourceAdapter(stateFor(allowed))
    await adapter.dispatch(request('hello'))
    const opened = await adapter.dispatch(await snapshotRequest(allowed))
    assert.equal(opened.status, 'error')
    if (opened.status !== 'error') assert.fail('Expected linked object directory refusal.')
    assert.equal(opened.error.code, 'GIT_LAYOUT_UNSUPPORTED')
  } finally {
    await rm(allowed, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  }
})

test('a missing promisor blob cannot trigger an implicit fetch', async () => {
  const root = await repository()
  const remoteParent = await mkdtemp(join(tmpdir(), 'nessie-deeptest-promisor-'))
  const remote = join(remoteParent, 'origin.git')
  try {
    await execFileAsync('git', ['clone', '--quiet', '--bare', root, remote])
    const oid = await git(root, ['rev-parse', 'HEAD:app.ts'])
    const objectPath = join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2))
    await git(root, ['config', 'remote.origin.url', remote])
    await git(root, ['config', 'remote.origin.promisor', 'true'])
    await git(root, ['config', 'remote.origin.partialclonefilter', 'blob:none'])
    await git(root, ['config', 'extensions.partialClone', 'origin'])
    await rm(objectPath)

    const adapter = createDeepTestSourceAdapter(stateFor(root))
    await adapter.dispatch(request('hello'))
    const opened = await adapter.dispatch(await snapshotRequest(root))
    assert.equal(opened.status, 'error')
    if (opened.status !== 'error') assert.fail('Expected a missing object refusal.')
    assert.equal(opened.error.code, 'SOURCE_UNAVAILABLE')
    await assert.rejects(access(objectPath))
  } finally {
    await rm(root, { force: true, recursive: true })
    await rm(remoteParent, { force: true, recursive: true })
  }
})
