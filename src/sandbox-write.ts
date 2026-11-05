import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'

import { ExecutorFileWriteArgumentsSchema } from '@nessie/executor-protocol'

import {
  MAX_SCRATCH_BYTES,
  MAX_SOURCE_FILES,
  assertOrdinaryDirectory,
  missing,
  writeAll,
  type SandboxUsage,
} from './sandbox-layout.js'
import { ensureSandboxWorkspace } from './sandbox-snapshot.js'
import {
  executorWorkspacePath,
  findExecutorWorkspaceFolder,
  splitExecutorWorkspacePath,
  type ExecutorWorkspaceFolder,
} from './workspace-folders.js'
import { WorkspacePathError, resolveWorkspaceWritePath } from './workspace-paths.js'

/**
 * A file write into a run's draft. The first path segment names the workspace
 * folder, and only that folder is snapshotted: writing into `nessie` never
 * copies, opens or touches any other paired directory. The write lands inside
 * that folder's COW snapshot, traverses no symbolic link, stays within the
 * scratch budget, and replaces an existing file atomically — a paired host
 * folder is never opened for writing.
 */

const ensureWriteParents = async (
  workspace: string,
  destination: string,
  createParents: boolean,
): Promise<void> => {
  const parent = dirname(destination)
  const segments = relative(workspace, parent).split(sep).filter(Boolean)
  let current = workspace
  for (const segment of segments) {
    current = resolve(current, segment)
    try {
      await assertOrdinaryDirectory(current, 'Sandbox paths may not traverse symbolic links.')
    } catch (error) {
      if (!missing(error)) throw error
      if (!createParents) throw new WorkspacePathError('The sandbox parent directory does not exist.')
      await mkdir(current, { mode: 0o700 })
      await assertOrdinaryDirectory(current, 'The sandbox parent directory is unavailable.')
    }
  }
}

const scratchUsage = async (root: string): Promise<SandboxUsage> => {
  const budget: SandboxUsage = { bytes: 0, files: 0 }
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      throw new WorkspacePathError('Sandbox workspaces may not contain symbolic links.')
    }
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true })
      for (const entry of entries) await walk(resolve(path, entry.name))
      return
    }
    if (!info.isFile() || info.nlink > 1) {
      throw new WorkspacePathError('Sandbox workspaces may contain only non-linked regular files.')
    }
    budget.files += 1
    budget.bytes += info.size
    if (budget.files > MAX_SOURCE_FILES || budget.bytes > MAX_SCRATCH_BYTES) {
      throw new WorkspacePathError('The sandbox workspace exceeds its storage limit.')
    }
  }
  await walk(root)
  return budget
}

export const writeSandboxFile = async (
  stateDir: string,
  folders: readonly ExecutorWorkspaceFolder[],
  runId: string,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const args = ExecutorFileWriteArgumentsSchema.parse(input)
  const requested = splitExecutorWorkspacePath(args.path)
  if (requested.folderName === undefined || requested.path === '.') {
    throw new WorkspacePathError(
      'A workspace file path names a folder and a file inside it, for example "nessie/notes.md".',
    )
  }
  const folder = findExecutorWorkspaceFolder(folders, requested.folderName)
  const workspace = await ensureSandboxWorkspace(stateDir, folder, runId)
  const destination = await resolveWorkspaceWritePath(workspace, requested.path)
  await ensureWriteParents(workspace, destination.path, args.createParents === true)
  let existingBytes = 0
  let isNewFile = true
  try {
    const existing = await lstat(destination.path)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new WorkspacePathError('The sandbox destination must be a regular file.')
    }
    if (args.overwrite !== true) {
      throw new WorkspacePathError('The sandbox destination already exists.')
    }
    existingBytes = existing.size
    isNewFile = false
  } catch (error) {
    if (!missing(error)) throw error
  }
  const usage = await scratchUsage(workspace)
  const nextBytes = usage.bytes - existingBytes + Buffer.byteLength(args.content, 'utf8')
  const nextFiles = usage.files + (isNewFile ? 1 : 0)
  if (nextBytes > MAX_SCRATCH_BYTES || nextFiles > MAX_SOURCE_FILES) {
    throw new WorkspacePathError('The sandbox workspace exceeds its storage limit.')
  }
  const temporary = resolve(dirname(destination.path), `.${basename(destination.path)}.${randomUUID()}.new`)
  await writeAll(temporary, args.content)
  try {
    if (args.overwrite !== true) {
      try {
        await lstat(destination.path)
        throw new WorkspacePathError('The sandbox destination already exists.')
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    await rename(temporary, destination.path)
  } finally {
    await rm(temporary, { force: true })
  }
  return {
    byteCount: Buffer.byteLength(args.content, 'utf8'),
    path: executorWorkspacePath(folder.name, destination.relativePath),
    success: true,
  }
}
