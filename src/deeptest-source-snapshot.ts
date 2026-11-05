import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

import { canonicalExecutorJson } from '@nessie/executor-protocol'

import {
  assertDeepTestGitLayout,
  DeepTestGitLayoutError,
} from './deeptest-source-git-layout.js'
import { configureWorkspaceFolderPath } from './workspace.js'

const execFileAsync = promisify(execFile)

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
const MAX_TREE_ENTRIES = 10_000
const MAX_TREE_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_READ_BYTES = 16 * 1024 * 1024

export type DeepTestSourceExclusionReason =
  | 'binary_file'
  | 'content_not_utf8'
  | 'file_too_large'
  | 'path_not_utf8'
  | 'path_unsupported'
  | 'snapshot_byte_limit'
  | 'submodule'
  | 'symbolic_link'
  | 'unsupported_mode'

export type DeepTestSourceInventoryEntry = {
  bytes: number | null
  digest: string | null
  path: string | null
  path_bytes_base64: string | null
  reason: DeepTestSourceExclusionReason | null
  status: 'excluded' | 'readable'
}

export type DeepTestSourceSnapshotFile = DeepTestSourceInventoryEntry & { content?: Buffer }

export type DeepTestSourceSnapshot = {
  commit: string
  coverage: {
    complete: boolean
    excluded_bytes: number
    excluded_files: number
    readable_bytes: number
    readable_files: number
    working_tree_changes_excluded: boolean
  }
  files: readonly DeepTestSourceSnapshotFile[]
  manifest_digest: string
  snapshot_id: string
  working_tree_state: 'clean' | 'dirty'
}

export class DeepTestSourceSnapshotError extends Error {
  constructor(
    readonly code: 'GIT_UNAVAILABLE' | 'OBJECT_FORMAT_UNSUPPORTED' | 'SOURCE_CHANGED'
      | 'SOURCE_INVENTORY_LIMIT' | 'SOURCE_UNAVAILABLE' | 'GIT_LAYOUT_UNSUPPORTED',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'DeepTestSourceSnapshotError'
  }
}

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  PAGER: 'cat',
  ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
  ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
  ...(process.env.WINDIR === undefined ? {} : { WINDIR: process.env.WINDIR }),
})

const git = async (
  root: string,
  args: readonly string[],
  options: { encoding?: BufferEncoding | null; maxBuffer?: number } = {},
): Promise<Buffer | string> => {
  try {
    const result = await execFileAsync(
      'git',
      ['-c', 'core.fsmonitor=false', '--git-dir', join(root, '.git'), '--work-tree', root, '-C', root, ...args],
      {
        encoding: options.encoding === undefined ? 'utf8' : options.encoding,
        env: gitEnvironment(),
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    )
    return result.stdout
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new DeepTestSourceSnapshotError(
        'GIT_UNAVAILABLE',
        'Git is required to open this Nessie source snapshot.',
        false,
      )
    }
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new DeepTestSourceSnapshotError(
        'SOURCE_INVENTORY_LIMIT',
        'This repository inventory is too large for the native source adapter.',
        false,
      )
    }
    throw new DeepTestSourceSnapshotError(
      'SOURCE_UNAVAILABLE',
      'The Nessie source snapshot is unavailable.',
      true,
    )
  }
}

const text = async (root: string, args: readonly string[]): Promise<string> =>
  String(await git(root, args)).trim()

const assertGitLayout = async (root: string): Promise<void> => {
  try {
    await assertDeepTestGitLayout(root, (args) => text(root, args))
  } catch (error) {
    if (error instanceof DeepTestGitLayoutError) {
      throw new DeepTestSourceSnapshotError(
        error.inventoryLimit ? 'SOURCE_INVENTORY_LIMIT' : 'GIT_LAYOUT_UNSUPPORTED',
        error.message,
        false,
      )
    }
    throw error
  }
}

const safePath = (bytes: Buffer): {
  encoded: string | null
  path: string | null
  reason: 'path_not_utf8' | 'path_unsupported' | null
} => {
  const decoded = bytes.toString('utf8')
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) {
    return { encoded: bytes.toString('base64'), path: null, reason: 'path_not_utf8' }
  }
  const segments = decoded.split('/')
  if (
    decoded.length === 0
    || decoded.length > 1_024
    || decoded.includes('\\')
    || decoded.startsWith('/')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) return { encoded: bytes.toString('base64'), path: null, reason: 'path_unsupported' }
  return { encoded: null, path: decoded, reason: null }
}

const exclusionFor = (
  mode: string,
  type: string,
  bytes: number | null,
  path: string | null,
  pathReason: 'path_not_utf8' | 'path_unsupported' | null,
): DeepTestSourceExclusionReason | null => {
  if (path === null) return pathReason ?? 'path_unsupported'
  if (mode === '120000') return 'symbolic_link'
  if (mode === '160000' || type === 'commit') return 'submodule'
  if (!['100644', '100755'].includes(mode) || type !== 'blob' || bytes === null) {
    return 'unsupported_mode'
  }
  if (bytes > MAX_FILE_BYTES) return 'file_too_large'
  return null
}

const parseTree = (output: Buffer): DeepTestSourceSnapshotFile[] => {
  if (output.byteLength === 0) return []
  const records = output.subarray(0, output.at(-1) === 0 ? -1 : undefined).toString('binary').split('\0')
  if (records.length > MAX_TREE_ENTRIES) {
    throw new DeepTestSourceSnapshotError(
      'SOURCE_INVENTORY_LIMIT',
      'This repository has more files than the native source adapter can inventory.',
      false,
    )
  }
  let admittedBytes = 0
  return records.map((record) => {
    const bytes = Buffer.from(record, 'binary')
    const tab = bytes.indexOf(0x09)
    const header = tab < 0 ? '' : bytes.subarray(0, tab).toString('ascii')
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40}) +(\d+|-)$/u.exec(header)
    if (!match || tab < 0) {
      throw new DeepTestSourceSnapshotError(
        'SOURCE_UNAVAILABLE',
        'The repository returned an unsupported source inventory.',
        false,
      )
    }
    const [, mode = '', type = '', oid = '', size = '-'] = match
    const bytesCount = size === '-' ? null : Number.parseInt(size, 10)
    const normalized = safePath(bytes.subarray(tab + 1))
    let reason = exclusionFor(mode, type, bytesCount, normalized.path, normalized.reason)
    if (reason === null && bytesCount !== null && admittedBytes + bytesCount > MAX_SNAPSHOT_BYTES) {
      reason = 'snapshot_byte_limit'
    }
    if (reason === null) admittedBytes += bytesCount ?? 0
    return {
      bytes: bytesCount,
      digest: type === 'blob' ? `git:${oid}` : null,
      path: normalized.path,
      path_bytes_base64: normalized.encoded,
      reason,
      status: reason === null ? 'readable' : 'excluded',
    }
  })
}

const loadBlobs = async (
  root: string,
  files: DeepTestSourceSnapshotFile[],
  assertActive: () => Promise<void>,
): Promise<void> => {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (const file of files) {
    if (file.status !== 'readable' || file.digest === null) continue
    await assertActive()
    const oid = file.digest.slice(4)
    const content = await git(root, ['cat-file', 'blob', oid], {
      encoding: null,
      maxBuffer: MAX_FILE_BYTES + 1,
    }) as Buffer
    const actual = createHash('sha1')
      .update(`blob ${String(content.byteLength)}\0`)
      .update(content)
      .digest('hex')
    if (actual !== oid || content.byteLength !== file.bytes) {
      throw new DeepTestSourceSnapshotError(
        'SOURCE_CHANGED',
        'The repository changed while Nessie was pinning its source snapshot.',
        true,
      )
    }
    await assertActive()
    if (content.includes(0)) {
      file.status = 'excluded'
      file.reason = 'binary_file'
      file.content = undefined
    } else {
      try {
        decoder.decode(content)
      } catch {
        file.status = 'excluded'
        file.reason = 'content_not_utf8'
        file.content = undefined
        continue
      }
      file.content = content
      file.digest = `sha256:${createHash('sha256').update(content).digest('hex')}`
    }
  }
}

const coverageFor = (
  files: readonly DeepTestSourceSnapshotFile[],
  workingTreeDirty: boolean,
): DeepTestSourceSnapshot['coverage'] => {
  let excludedBytes = 0
  let excludedFiles = 0
  let readableBytes = 0
  let readableFiles = 0
  for (const file of files) {
    if (file.status === 'readable') {
      readableBytes += file.bytes ?? 0
      readableFiles += 1
    } else {
      excludedBytes += file.bytes ?? 0
      excludedFiles += 1
    }
  }
  return {
    complete: excludedFiles === 0 && !workingTreeDirty,
    excluded_bytes: excludedBytes,
    excluded_files: excludedFiles,
    readable_bytes: readableBytes,
    readable_files: readableFiles,
    working_tree_changes_excluded: workingTreeDirty,
  }
}

export const createDeepTestSourceSnapshot = async (
  workspaceRoot: string,
  expectedSourceRoot: string,
  assertActive: () => Promise<void> = async () => undefined,
): Promise<DeepTestSourceSnapshot> => {
  await assertActive()
  const root = await configureWorkspaceFolderPath(workspaceRoot)
  if (await configureWorkspaceFolderPath(expectedSourceRoot) !== root) {
    throw new DeepTestSourceSnapshotError(
      'SOURCE_UNAVAILABLE',
      'The review source does not match this Nessie workspace.',
      false,
    )
  }
  await assertGitLayout(root)
  const repositoryRoot = await text(root, ['rev-parse', '--show-toplevel'])
  if (await configureWorkspaceFolderPath(repositoryRoot) !== root) {
    throw new DeepTestSourceSnapshotError(
      'SOURCE_UNAVAILABLE',
      'Select the repository root as the Nessie workspace before starting this review.',
      false,
    )
  }
  if (await text(root, ['rev-parse', '--show-object-format']) !== 'sha1') {
    throw new DeepTestSourceSnapshotError(
      'OBJECT_FORMAT_UNSUPPORTED',
      'This repository uses an object format the native source adapter does not support.',
      false,
    )
  }
  const commit = await text(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new DeepTestSourceSnapshotError(
      'SOURCE_UNAVAILABLE',
      'The selected Nessie workspace has no reviewable Git commit.',
      false,
    )
  }
  const dirtyBefore = (await git(root, ['status', '--porcelain=v1', '--ignore-submodules=all', '-z'], {
    encoding: null,
    maxBuffer: MAX_TREE_OUTPUT_BYTES,
  }) as Buffer).byteLength > 0
  const tree = await git(root, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit], {
    encoding: null,
    maxBuffer: MAX_TREE_OUTPUT_BYTES,
  }) as Buffer
  const files = parseTree(tree)
  await loadBlobs(root, files, assertActive)
  await assertActive()
  const commitAfter = await text(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const dirtyAfter = (await git(root, ['status', '--porcelain=v1', '--ignore-submodules=all', '-z'], {
    encoding: null,
    maxBuffer: MAX_TREE_OUTPUT_BYTES,
  }) as Buffer).byteLength > 0
  if (commitAfter !== commit || dirtyAfter !== dirtyBefore) {
    throw new DeepTestSourceSnapshotError(
      'SOURCE_CHANGED',
      'The repository changed while Nessie was pinning its source snapshot.',
      true,
    )
  }
  const coverage = coverageFor(files, false)
  coverage.working_tree_changes_excluded = dirtyBefore
  const manifestDigest = `sha256:${createHash('sha256').update(canonicalExecutorJson({
    commit,
    files: files.map(({ content: _content, ...entry }) => entry),
    working_tree_state: dirtyBefore ? 'dirty' : 'clean',
  })).digest('hex')}`
  return {
    commit,
    coverage,
    files,
    manifest_digest: manifestDigest,
    snapshot_id: randomUUID(),
    working_tree_state: dirtyBefore ? 'dirty' : 'clean',
  }
}

export const inventoryPage = (
  snapshot: DeepTestSourceSnapshot,
  cursor: string | undefined,
  maximum: number | undefined,
): Record<string, unknown> => {
  const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10)
  const count = maximum ?? 200
  const entries = snapshot.files.slice(start, start + count).map(({ content: _content, ...entry }) => entry)
  const next = start + entries.length
  return {
    commit: snapshot.commit,
    coverage: snapshot.coverage,
    entries,
    manifest_digest: snapshot.manifest_digest,
    next_cursor: next < snapshot.files.length ? String(next) : null,
    snapshot_id: snapshot.snapshot_id,
    working_tree_state: snapshot.working_tree_state,
  }
}

export const readSnapshotFiles = (
  snapshot: DeepTestSourceSnapshot,
  paths: readonly string[],
): { incomplete: boolean; result: Record<string, unknown> } => {
  const index = new Map(snapshot.files.filter((file) => file.path !== null).map((file) => [file.path, file]))
  let bytes = 0
  for (const path of paths) {
    const file = index.get(path)
    if (file?.status === 'readable') bytes += file.bytes ?? 0
  }
  if (bytes > MAX_READ_BYTES) {
    return {
      incomplete: true,
      result: {
        code: 'READ_BYTES_LIMIT',
        commit: snapshot.commit,
        maximum_bytes: MAX_READ_BYTES,
        message: 'Request fewer source files and continue the review.',
        snapshot_id: snapshot.snapshot_id,
      },
    }
  }
  let incomplete = false
  const files = paths.map((path) => {
    const file = index.get(path)
    if (file === undefined) {
      incomplete = true
      return { bytes: null, content: null, digest: null, path, reason: 'not_in_snapshot', status: 'excluded' }
    }
    if (file.status === 'excluded' || file.content === undefined) {
      incomplete = true
      return {
        bytes: file.bytes,
        content: null,
        digest: file.digest,
        path,
        reason: file.reason,
        status: 'excluded',
      }
    }
    return {
      bytes: file.content.byteLength,
      content: file.content.toString('utf8'),
      digest: file.digest,
      path,
      reason: null,
      status: 'readable',
    }
  })
  return {
    incomplete,
    result: { commit: snapshot.commit, files, snapshot_id: snapshot.snapshot_id },
  }
}
