import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { canonicalExecutorJson, RunIdSchema } from '@nessie/executor-protocol'

import {
  COPY_BUFFER_BYTES,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILES,
  assertOrdinaryDirectory,
  missing,
  sandboxFolderPaths,
  writeAll,
  type SandboxUsage,
} from './sandbox-layout.js'
import { relativeManifestPath, type BaseManifest, type ManifestEntry } from './sandbox-manifest.js'
import {
  WorkspacePathError,
  EXECUTOR_PROMOTION_JOURNAL_DIRECTORY,
  configureOrdinaryDirectory,
  isInsideDirectory,
} from './workspace-paths.js'
import type { ExecutorWorkspaceFolder } from './workspace-folders.js'
import { configureWorkspaceFolderPath } from './workspace.js'

/**
 * Building one workspace folder's copy-on-write snapshot from its paired host
 * directory. The copy follows no link, admits no special file, stays within the
 * source budget, and records the content hash of every file it copies as the
 * base manifest the review later compares against. A paired folder is only ever
 * read here.
 */

const copyFileWithoutFollowingLinks = async (
  source: string,
  destination: string,
  budget: SandboxUsage,
): Promise<ManifestEntry> => {
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await sourceHandle.stat()
    if (!info.isFile() || info.nlink > 1) {
      throw new WorkspacePathError('Sandbox sources may contain only non-linked regular files.')
    }
    budget.files += 1
    budget.bytes += info.size
    if (budget.files > MAX_SOURCE_FILES || budget.bytes > MAX_SOURCE_BYTES) {
      throw new WorkspacePathError('The paired workspace exceeds the sandbox copy limit.')
    }
    const destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
      const hasher = createHash('sha256')
      let position = 0
      while (true) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        let written = 0
        hasher.update(buffer.subarray(0, bytesRead))
        while (written < bytesRead) {
          const write = await destinationHandle.write(buffer, written, bytesRead - written, position + written)
          written += write.bytesWritten
        }
        position += bytesRead
      }
      await destinationHandle.sync()
      return { byteCount: info.size, digest: `sha256:${hasher.digest('hex')}` }
    } finally {
      await destinationHandle.close()
    }
  } finally {
    await sourceHandle.close()
  }
}

const copyTreeWithoutLinks = async (
  source: string,
  destination: string,
  budget: SandboxUsage,
  baseFiles: Record<string, ManifestEntry>,
  sourceRoot: string,
): Promise<void> => {
  const info = await lstat(source)
  if (info.isSymbolicLink()) {
    throw new WorkspacePathError('Sandbox sources may not contain symbolic links.')
  }
  if (info.isDirectory()) {
    await mkdir(destination, { mode: 0o700 })
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries
      .filter((entry) => source !== sourceRoot || entry.name !== EXECUTOR_PROMOTION_JOURNAL_DIRECTORY)
      .sort((left, right) => left.name.localeCompare(right.name))) {
      await copyTreeWithoutLinks(
        resolve(source, entry.name),
        resolve(destination, entry.name),
        budget,
        baseFiles,
        sourceRoot,
      )
    }
    return
  }
  if (info.isFile()) {
    baseFiles[relativeManifestPath(sourceRoot, source)] = await copyFileWithoutFollowingLinks(
      source,
      destination,
      budget,
    )
    return
  }
  throw new WorkspacePathError('Sandbox sources may not contain special files.')
}

/**
 * Lazily creates a daemon-owned, copy-on-write snapshot of one workspace folder
 * for one run. The folder's host directory is read only here; no command can
 * write it. A future promote operation must perform its own reviewed host-write
 * protocol.
 *
 * Each folder is staged and renamed on its own, so a run that drafts two
 * folders ends up with two independent snapshots and a failed copy of the
 * second leaves the first intact.
 */
export const ensureSandboxWorkspace = async (
  stateDir: string,
  folder: ExecutorWorkspaceFolder,
  runId: string,
): Promise<string> => {
  const source = await configureWorkspaceFolderPath(folder.path)
  const paths = await sandboxFolderPaths(stateDir, runId, folder.name)
  try {
    await assertOrdinaryDirectory(paths.root, 'The executor sandbox is unavailable.')
  } catch (error) {
    if (!missing(error)) throw error
    // The run root and its `folders/` level are shared by every folder of this
    // run, so they are created idempotently; only the folder itself is renamed
    // into place, which is what makes one folder's snapshot atomic.
    await mkdir(paths.parent, { mode: 0o700, recursive: true })
    await assertOrdinaryDirectory(paths.run, 'The executor sandbox is unavailable.')
    await assertOrdinaryDirectory(paths.parent, 'The executor sandbox is unavailable.')
    const staging = resolve(paths.parent, `.${paths.name}.${RunIdSchema.parse(runId)}.${randomUUID()}.new`)
    if (!isInsideDirectory(paths.parent, staging)) {
      throw new WorkspacePathError('The executor sandbox staging path is invalid.')
    }
    await mkdir(staging, { mode: 0o700 })
    try {
      const base: BaseManifest = { files: {}, version: 1 }
      await copyTreeWithoutLinks(
        source,
        resolve(staging, 'workspace'),
        { bytes: 0, files: 0 },
        base.files,
        source,
      )
      await writeAll(resolve(staging, 'base-manifest.json'), canonicalExecutorJson(base))
      await rename(staging, paths.root)
    } catch (copyError) {
      await rm(staging, { force: true, recursive: true })
      throw copyError
    }
    return configureOrdinaryDirectory(paths.workspace, 'The executor sandbox workspace')
  }
  try {
    return await configureOrdinaryDirectory(paths.workspace, 'The executor sandbox workspace')
  } catch (error) {
    throw new WorkspacePathError(
      error instanceof Error ? error.message : 'The executor sandbox workspace is unavailable.',
    )
  }
}
