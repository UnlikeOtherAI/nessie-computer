import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { StateSecurityDeps } from '../state-security.js'
import { readMarker, saveFolderSyncConfig, writeMarker, type FolderSyncConfig } from './config.js'
import { EngineStore } from './engine-store.js'
import { rootRealPath } from './local-fs.js'
import { createIndexStorePort, type FolderSyncPaths } from './state-files.js'
import { chooseTeamFolder, type TeamFolderNames } from './team-folder.js'

/**
 * Which folder a pass syncs: the root the person chose (C21), the team's folder
 * under it, and the index that belongs to that folder's identity.
 */

const caseFold = (path: string) => (process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path)

/** C21: the root is the folder chosen (same real path) and holds this sync's marker. */
export const syncRootPresent = async (config: FolderSyncConfig, executorId: string): Promise<boolean> => {
  const real = await rootRealPath(config.root!)
  if (!real || (config.rootRealPath && caseFold(real) !== caseFold(config.rootRealPath))) return false
  const marker = await readMarker(config.root!, executorId)
  return marker !== null && marker.syncId === config.syncId
}

/**
 * The team's folder under the root: named once, from the team's and its
 * organisation's names (`team-folder.ts`), then fixed. `names` is asked only
 * when the folder has no name yet.
 */
export const ensureTeamFolder = async (
  config: FolderSyncConfig,
  context: {
    stateDir: string; executorId: string; names: () => Promise<TeamFolderNames>; now: number
    security?: StateSecurityDeps
  },
): Promise<string> => {
  if (!config.teamFolder) {
    config.teamFolder = await chooseTeamFolder(config.root!, await context.names(), context.executorId)
    await saveFolderSyncConfig(context.stateDir, config, context.security)
    const marker = await readMarker(config.root!, context.executorId)
    await writeMarker(config.root!, {
      syncId: config.syncId!, executorId: context.executorId, teamFolder: config.teamFolder,
      createdAt: marker?.createdAt ?? new Date(context.now).toISOString(),
    })
  }
  return join(config.root!, config.teamFolder)
}

/**
 * The index belongs to one folder identity: the `syncId` it was built for, or
 * null before any. A new `syncId` (another folder was chosen) starts a fresh
 * index (`resetFolderIndex`), so nothing the old folder held is read as
 * deleted from the new one.
 */
export const folderIndexOwner = (paths: FolderSyncPaths): Promise<string | null> =>
  readFile(join(paths.dir, 'index-sync-id'), 'utf8').catch(() => null)

export const resetFolderIndex = async (paths: FolderSyncPaths, syncId: string | null): Promise<void> => {
  for (const name of ['index.json', 'journal.ndjson']) await rm(join(paths.dir, name), { force: true })
  for (const name of await readdir(paths.bases).catch(() => [] as string[])) {
    await rm(join(paths.bases, name), { force: true })
  }
  await writeFile(join(paths.dir, 'index-sync-id'), syncId ?? '', { mode: 0o600 })
}

export const openFolderStore = (paths: FolderSyncPaths, security?: StateSecurityDeps): Promise<EngineStore> =>
  EngineStore.open(createIndexStorePort(paths, security))
