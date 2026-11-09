import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { RunIdSchema } from '@nessie/executor-protocol'

import { ensureExecutorRuntimeDirectory } from './state-store.js'
import { assertExecutorWorkspaceFolderName } from './workspace-folders.js'
import { WorkspacePathError, isInsideDirectory } from './workspace-paths.js'

/**
 * Where a run's sandbox lives, how much it may hold, and the guards every
 * operation on it shares. The snapshot, the draft writes, and the review each
 * build on exactly these facts and never restate them.
 */

// A draft never has more storage than the snapshot it started from. Keeping
// these limits equal avoids copying a source tree that can never accept a
// write, while still leaving ordinary read-only operations unconstrained by
// the COW cap.
//
// The budget is per workspace folder, because a folder is snapshotted on its
// own and only when a draft needs it. A run that drafts several folders can
// therefore hold a multiple of this, bounded by the folder maximum in
// `@nessie/executor-protocol`.
export const MAX_SOURCE_BYTES = 128 * 1024 * 1024
export const MAX_SOURCE_FILES = 10_000
export const MAX_SCRATCH_BYTES = MAX_SOURCE_BYTES
export const COPY_BUFFER_BYTES = 64 * 1024

/** One level of indirection so a folder can never be named `base-manifest.json`. */
export const SANDBOX_FOLDERS_DIRECTORY = 'folders'

/** Bytes and files counted against one of the limits above. */
export type SandboxUsage = { bytes: number; files: number }

export const missing = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')

export const assertOrdinaryDirectory = async (path: string, message: string): Promise<void> => {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkspacePathError(message)
}

const sandboxDirectory = async (stateDir: string): Promise<string> => {
  const runtimeDir = await ensureExecutorRuntimeDirectory(stateDir)
  const sandboxes = resolve(runtimeDir, 'sandboxes')
  await mkdir(sandboxes, { mode: 0o700, recursive: true })
  await assertOrdinaryDirectory(sandboxes, 'The sandbox directory is unavailable.')
  return sandboxes
}

/** Where one run's sandbox lives, and where its per-folder drafts sit. */
export const sandboxPaths = async (stateDir: string, runId: string) => {
  const parsedRunId = RunIdSchema.parse(runId)
  const parent = await sandboxDirectory(stateDir)
  const root = resolve(parent, parsedRunId)
  if (!isInsideDirectory(parent, root) || basename(root) !== parsedRunId) {
    throw new WorkspacePathError('The sandbox identity is invalid.')
  }
  return { folders: resolve(root, SANDBOX_FOLDERS_DIRECTORY), parent, root }
}

/**
 * A run has one sandbox per workspace folder it touched, each with its own
 * snapshot, base manifest and guest lease. A folder nobody wrote to has no
 * directory here at all: reads of it stay on the host copy, which is why the
 * copy cost of a second folder is paid only when a draft needs it.
 *
 * The folder name is re-validated against the grammar here, not trusted from
 * the caller: this is the one place a name becomes a directory component.
 */
export const sandboxFolderPaths = async (stateDir: string, runId: string, folderName: string) => {
  const run = await sandboxPaths(stateDir, runId)
  const name = assertExecutorWorkspaceFolderName(folderName)
  const root = resolve(run.folders, name)
  if (!isInsideDirectory(run.folders, root) || basename(root) !== name) {
    throw new WorkspacePathError('The sandbox folder identity is invalid.')
  }
  return {
    baseManifest: resolve(root, 'base-manifest.json'),
    guestLease: resolve(root, 'guest-lease.json'),
    name,
    parent: run.folders,
    root,
    run: run.root,
    workspace: resolve(root, 'workspace'),
  }
}

/**
 * The folders this run has a draft for, in name order. A directory that is not
 * a legal folder name never becomes one: it is refused rather than skipped, so
 * a tampered runtime directory cannot quietly shrink a review.
 */
export const sandboxDraftFolderNames = async (stateDir: string, runId: string): Promise<string[]> => {
  const run = await sandboxPaths(stateDir, runId)
  let entries
  try {
    entries = await readdir(run.folders, { withFileTypes: true })
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
  return entries
    .map((entry) => {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new WorkspacePathError('The sandbox contains an unexpected entry.')
      }
      return assertExecutorWorkspaceFolderName(entry.name)
    })
    .sort()
}

/** Creates an owner-only file that must not already exist, then syncs it. */
export const writeAll = async (path: string, content: string): Promise<void> => {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const bytes = Buffer.from(content, 'utf8')
    let written = 0
    while (written < bytes.byteLength) {
      const result = await handle.write(bytes, written, bytes.byteLength - written, written)
      written += result.bytesWritten
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}
