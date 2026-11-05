import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { assertPersonalInferenceWorkspace } from './personal-inference-paths.js'

import {
  ExecutorFileListArgumentsSchema,
  ExecutorFileReadArgumentsSchema,
} from '@nessie/executor-protocol'

import {
  executorWorkspacePath,
  findExecutorWorkspaceFolder,
  splitExecutorWorkspacePath,
  type ExecutorWorkspaceFolder,
} from './workspace-folders.js'
import {
  WorkspacePathError,
  EXECUTOR_PROMOTION_JOURNAL_DIRECTORY,
  configureOrdinaryDirectory,
  resolveExistingWorkspacePath,
} from './workspace-paths.js'

const DEFAULT_READ_BYTES = 4_096
const DEFAULT_LIST_ENTRIES = 100

/** A paired folder's host directory must remain a real, ordinary directory. */
export const configureWorkspaceFolderPath = async (value: string): Promise<string> => {
  if (!isAbsolute(value)) throw new WorkspacePathError('A workspace folder must be an absolute path.')
  const canonical = await configureOrdinaryDirectory(value, 'The workspace folder')
  await assertPersonalInferenceWorkspace(canonical)
  return canonical
}

/**
 * The folder namespace one operation reads, and where each folder's bytes come
 * from. `directoryFor` is what lets the same code serve a live host folder and a
 * run's copy-on-write draft of it without either one leaking into path
 * resolution: the folder set decides *which* directory, the resolver decides
 * *where* it is, and `workspace-paths.ts` still guards everything beneath it.
 */
export type ExecutorWorkspaceView = {
  directoryFor: (folder: ExecutorWorkspaceFolder) => Promise<string>
  folders: readonly ExecutorWorkspaceFolder[]
}

const readAtMost = async (path: string, maxBytes: number): Promise<{ bytes: number; data: Buffer }> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
      if (bytesRead === 0) break
      bytes += bytesRead
    }
    return { bytes, data: buffer.subarray(0, Math.min(bytes, maxBytes)) }
  } finally {
    await handle.close()
  }
}

/**
 * The namespace root: the folders themselves, so an agent that has been handed
 * an executor can discover what it may reach before it names anything. The
 * shape is the same listing a directory returns, which is what lets an agent
 * take a name straight from here and use it as the first segment of a read.
 */
const listWorkspaceFolders = (
  folders: readonly ExecutorWorkspaceFolder[],
  maxEntries: number,
): Record<string, unknown> => {
  const names = [...folders].map((folder) => folder.name).sort()
  const visible = names.slice(0, maxEntries)
  return {
    entries: visible.map((name) => ({ kind: 'directory', name })),
    path: '.',
    success: true,
    truncated: names.length > visible.length,
  }
}

export const listWorkspaceFiles = async (
  view: ExecutorWorkspaceView,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const args = ExecutorFileListArgumentsSchema.parse(input)
  const requestedEntries = args.maxEntries ?? DEFAULT_LIST_ENTRIES
  const requested = splitExecutorWorkspacePath(args.path)
  if (requested.folderName === undefined) return listWorkspaceFolders(view.folders, requestedEntries)
  const folder = findExecutorWorkspaceFolder(view.folders, requested.folderName)
  const path = await resolveExistingWorkspacePath(await view.directoryFor(folder), requested.path)
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkspacePathError('The requested workspace path is not a directory.')
  }
  const entries = await readdir(path, { withFileTypes: true })
  const admitted = entries
    .filter((entry) => !entry.isSymbolicLink())
    // The promotion journal is per folder, so it is hidden at each folder's own
    // root rather than only at the namespace root.
    .filter((entry) => requested.path !== '.' || entry.name !== EXECUTOR_PROMOTION_JOURNAL_DIRECTORY)
  const visible = admitted
    .slice(0, requestedEntries)
    .map((entry) => ({
      kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      name: entry.name.slice(0, 120),
    }))
  return {
    entries: visible,
    path: executorWorkspacePath(folder.name, requested.path),
    success: true,
    truncated: admitted.length > visible.length,
  }
}

export const readWorkspaceFile = async (
  view: ExecutorWorkspaceView,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const args = ExecutorFileReadArgumentsSchema.parse(input)
  const requested = splitExecutorWorkspacePath(args.path)
  if (requested.folderName === undefined || requested.path === '.') {
    throw new WorkspacePathError(
      'A workspace file path names a folder and a file inside it, for example "nessie/README.md".',
    )
  }
  const folder = findExecutorWorkspaceFolder(view.folders, requested.folderName)
  const path = await resolveExistingWorkspacePath(await view.directoryFor(folder), requested.path)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new WorkspacePathError('The requested workspace path is not a regular file.')
  }
  const maxBytes = args.maxBytes ?? DEFAULT_READ_BYTES
  const result = await readAtMost(path, maxBytes)
  return {
    byteCount: result.data.byteLength,
    content: result.data.toString('utf8'),
    path: executorWorkspacePath(folder.name, requested.path),
    success: true,
    truncated: result.bytes > maxBytes,
  }
}

export const workspaceFailure = (error: unknown): Record<string, unknown> => ({
  code: error instanceof WorkspacePathError ? 'EXECUTOR_WORKSPACE_DENIED' : 'EXECUTOR_WORKSPACE_UNAVAILABLE',
  success: false,
})
