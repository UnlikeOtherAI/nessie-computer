import { lstat, rm } from 'node:fs/promises'

import {
  assertOrdinaryDirectory,
  missing,
  sandboxDraftFolderNames,
  sandboxFolderPaths,
  sandboxPaths,
} from './sandbox-layout.js'
import type { ExecutorWorkspaceFolder } from './workspace-folders.js'
import { WorkspacePathError, configureOrdinaryDirectory } from './workspace-paths.js'
import { configureWorkspaceFolderPath, type ExecutorWorkspaceView } from './workspace.js'

/**
 * A run's sandbox, seen from the daemon: which directory each workspace folder's
 * commands work in and when the drafts are discarded. Building the snapshots,
 * writing into them, and reviewing them are each their own module; this one
 * re-exports their entry points so the daemon reaches the whole lifecycle
 * through one import.
 */
export { sandboxFolderPaths, sandboxPaths } from './sandbox-layout.js'
export { promotionManifestForSandbox, reviewSandboxWorkspace } from './sandbox-manifest.js'
export type {
  SandboxFolderManifest,
  SandboxFolderPromotion,
  SandboxPromotionManifest,
} from './sandbox-manifest.js'
export { ensureSandboxWorkspace } from './sandbox-snapshot.js'
export { writeSandboxFile } from './sandbox-write.js'

/** Use a folder's COW draft when it exists; read-only work keeps the host copy. */
export const workspaceForRun = async (
  stateDir: string,
  folder: ExecutorWorkspaceFolder,
  runId: string,
): Promise<string> => {
  const paths = await sandboxFolderPaths(stateDir, runId, folder.name)
  try {
    return await configureOrdinaryDirectory(paths.workspace, 'The executor sandbox workspace')
  } catch (error) {
    try {
      await assertOrdinaryDirectory(paths.root, 'The executor sandbox is unavailable.')
    } catch (rootError) {
      if (!missing(rootError)) throw rootError
      // This folder has no draft for this run. Another folder of the same run
      // may still have one; each folder answers for itself.
      return configureWorkspaceFolderPath(folder.path)
    }
    throw error
  }
}

/**
 * The namespace one run reads: every configured folder, each resolved to its own
 * draft when it has one. Built per operation rather than cached, so a folder
 * that gains a draft mid-run is seen by the next read.
 */
export const workspaceViewForRun = (
  stateDir: string,
  folders: readonly ExecutorWorkspaceFolder[],
  runId: string,
): ExecutorWorkspaceView => ({
  directoryFor: async (folder) => await workspaceForRun(stateDir, folder, runId),
  folders,
})

/**
 * Stop discards only the exact daemon-owned COW state for this run, across every
 * folder it drafted. One folder still mounted by a guest blocks the whole
 * teardown: the run's sandbox is one unit of consent, and half-erasing it would
 * leave a guest writing into a directory the daemon believes is gone.
 */
export const stopSandboxWorkspace = async (stateDir: string, runId: string): Promise<boolean> => {
  const paths = await sandboxPaths(stateDir, runId)
  try {
    await assertOrdinaryDirectory(paths.root, 'The executor sandbox is unavailable.')
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
  for (const name of await sandboxDraftFolderNames(stateDir, runId)) {
    const folder = await sandboxFolderPaths(stateDir, runId, name)
    try {
      const lease = await lstat(folder.guestLease)
      if (lease.isSymbolicLink() || !lease.isFile()) {
        throw new WorkspacePathError('The executor guest lease is unavailable.')
      }
      throw new WorkspacePathError('The executor sandbox has an active guest lease.')
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  await rm(paths.root, { force: true, recursive: true })
  return true
}
