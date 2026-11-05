import { homedir } from 'node:os'

import {
  FOLDER_SYNC_CONSOLE_LIST_LIMIT,
  FolderSyncConsoleStateSchema,
  type FolderSyncConsoleState,
  type FolderSyncCounts,
  type FolderSyncDescription,
  type FolderSyncEngineState,
  type FolderSyncHeldDeletes,
  type FolderSyncNotSyncedItem,
  type FolderSyncRecordStatus,
  type SyncExcludedSpace,
  type SyncPage,
} from '@nessie/executor-protocol'

import type { StateSecurityDeps } from '../state-security.js'
import { defaultFolderSyncRoot, loadFolderSyncConfig } from './config.js'
import { mapTree } from './path-mapping.js'
import type { RemoteManifest } from './reconcile-model.js'
import { ConflictBook } from './report.js'
import { folderSyncPaths, readStateJson, writeStateJson } from './state-files.js'

/**
 * What the native console reads (`sync status --json`, plan §5.2): the
 * machine's switch and folder from `config.json`, the engine's last word from
 * `status.json`, and the open rows from `conflicts.json`. The daemon writes the
 * last two; the CLI only reads them, so the console works whether or not the
 * daemon is running and never talks to Nessie itself.
 */

export type FolderSyncStatusFile = {
  version: 1
  state: FolderSyncEngineState
  serverStatus: FolderSyncRecordStatus | null
  manageUrl: string | null
  teamLabel: string | null
  counts: FolderSyncCounts
  activity: { uploading: number; downloading: number }
  lastReconcileAt: string | null
  heldDeletes: FolderSyncHeldDeletes | null
  excludedSpaces: SyncExcludedSpace[]
  notSynced: FolderSyncNotSyncedItem[]
  updatedAt: string
}

export const EMPTY_COUNTS: FolderSyncCounts = {
  entries: 0, pendingUploads: 0, pendingDownloads: 0, openConflicts: 0,
  waiting: 0, errors: 0, heldDeletes: 0, notSynced: 0,
}

export const emptyStatusFile = (): FolderSyncStatusFile => ({
  version: 1,
  state: 'off',
  serverStatus: null,
  manageUrl: null,
  teamLabel: null,
  counts: EMPTY_COUNTS,
  activity: { uploading: 0, downloading: 0 },
  lastReconcileAt: null,
  heldDeletes: null,
  excludedSpaces: [],
  notSynced: [],
  updatedAt: new Date(0).toISOString(),
})

export const readStatusFile = (stateDir: string): Promise<FolderSyncStatusFile> =>
  readStateJson(folderSyncPaths(stateDir).status, emptyStatusFile())

export const writeStatusFile = (
  stateDir: string, status: FolderSyncStatusFile, security: StateSecurityDeps = {},
): Promise<void> => writeStateJson(folderSyncPaths(stateDir).status, status, security)

/**
 * Everything readable in Nessie that is not on disk, and why: spaces kept out,
 * versions the owner may not see or pages with nothing yet, links found here.
 * Returns the bounded list and the full count.
 */
export const notSyncedItems = (
  manifest: RemoteManifest,
  excludedSpaces: readonly SyncExcludedSpace[],
  links: readonly string[],
): { items: FolderSyncNotSyncedItem[]; count: number } => {
  const mapping = mapTree(manifest.spaces, manifest.pages)
  const all: FolderSyncNotSyncedItem[] = [
    ...excludedSpaces.map((space) => ({ relPath: null, spaceId: space.spaceId, reason: space.reason })),
    ...manifest.pages
      .filter((page): page is SyncPage & { notSyncedReason: NonNullable<SyncPage['notSyncedReason']> } =>
        page.notSyncedReason !== null)
      .map((page) => ({
        relPath: mapping.paths.get(page.id) ?? null, spaceId: page.spaceId, reason: page.notSyncedReason,
      })),
    ...links.map((relPath) => ({ relPath, spaceId: null, reason: 'link' as const })),
  ]
  return { items: all.slice(0, FOLDER_SYNC_CONSOLE_LIST_LIMIT), count: all.length }
}

/** The console's whole view of one paired team's sync, validated against the shared schema. */
export const readConsoleState = async (
  stateDir: string, executorId: string, home = homedir(),
): Promise<FolderSyncConsoleState> => {
  const paths = folderSyncPaths(stateDir)
  const config = await loadFolderSyncConfig(stateDir)
  const status = await readStatusFile(stateDir)
  const book = await ConflictBook.open(paths.conflicts)
  const enabled = config.enabled && config.root !== null
  return FolderSyncConsoleStateSchema.parse({
    executorId,
    // The team folder's name on disk: the console finds a file at root/teamLabel/relPath.
    teamLabel: config.teamFolder,
    enabled,
    paused: config.paused,
    root: config.root,
    defaultRoot: defaultFolderSyncRoot(home),
    trashPath: paths.trash,
    // Switched on here but not yet run is `starting`; turned off in Nessie stays `off`.
    state: !enabled ? 'off' : config.paused ? 'paused'
      : status.state === 'off' && status.serverStatus !== 'disabled' ? 'starting' : status.state,
    serverStatus: status.serverStatus,
    manageUrl: status.manageUrl,
    counts: status.counts,
    activity: status.activity,
    lastReconcileAt: status.lastReconcileAt,
    conflicts: book.consoleRows(),
    heldDeletes: status.heldDeletes,
    notSynced: status.notSynced,
  })
}

/** `describe --json`'s `folderSync` block. */
export const describeFolderSync = async (stateDir: string, executorId: string): Promise<FolderSyncDescription> => {
  const state = await readConsoleState(stateDir, executorId)
  return { enabled: state.enabled, root: state.root, state: state.state, counts: state.counts }
}
