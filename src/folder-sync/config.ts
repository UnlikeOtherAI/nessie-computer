import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { FolderSyncConsoleRefusal } from '@nessie/executor-protocol'

import type { StateSecurityDeps } from '../state-security.js'
import type { ExecutorWorkspaceFolder } from '../workspace-folders.js'
import { isIgnoredName } from './ignore.js'
import { directoryWritable, fsPath, lstatOrNull, writeNewFile } from './local-fs.js'
import { folderSyncPaths, readStateJson, writeStateJson } from './state-files.js'

/**
 * The machine's half of the switch (plan §2.1, §5.1): which folder, on or off,
 * paused, and the folder's identity. It lives in `<stateDir>/folder-sync/
 * config.json`, not in the executor descriptor, so turning sync on or off is
 * never a policy revision. Only `basename(root)` is ever sent upstream.
 */

export const FOLDER_SYNC_CONFIG_VERSION = 1

export type FolderSyncConfig = {
  version: typeof FOLDER_SYNC_CONFIG_VERSION
  /** Absolute; null until a folder is chosen. */
  root: string | null
  /** The root's real path when it was chosen: a changed identity is `root_missing`. */
  rootRealPath: string | null
  enabled: boolean
  paused: boolean
  includeSensitive: boolean
  /** The folder's identity, also written to its marker; a new one starts a fresh index. */
  syncId: string | null
  /** The team's folder under the root, allocated once from the handshake's label. */
  teamFolder: string | null
}

export const emptyFolderSyncConfig = (): FolderSyncConfig => ({
  version: FOLDER_SYNC_CONFIG_VERSION,
  root: null,
  rootRealPath: null,
  enabled: false,
  paused: false,
  includeSensitive: true,
  syncId: null,
  teamFolder: null,
})

export const loadFolderSyncConfig = async (stateDir: string): Promise<FolderSyncConfig> => {
  const stored = await readStateJson<Partial<FolderSyncConfig> | null>(folderSyncPaths(stateDir).config, null)
  if (stored === null) return emptyFolderSyncConfig()
  if (stored.version !== FOLDER_SYNC_CONFIG_VERSION) throw new Error('folder-sync/config.json has an unknown format.')
  return { ...emptyFolderSyncConfig(), ...stored }
}

export const saveFolderSyncConfig = (
  stateDir: string, config: FolderSyncConfig, security: StateSecurityDeps = {},
): Promise<void> => writeStateJson(folderSyncPaths(stateDir).config, config, security)

/**
 * Turned off in Nessie: the switch here goes off too. Nessie's handshake asks
 * again for a turned-off sync, so a daemon that kept its switch on re-raised
 * the request within seconds; only a person turning it on here asks anew.
 */
export const switchFolderSyncOffHere = async (stateDir: string, security: StateSecurityDeps = {}): Promise<void> => {
  const config = await loadFolderSyncConfig(stateDir)
  if (config.enabled) await saveFolderSyncConfig(stateDir, { ...config, enabled: false }, security)
}

/** `~/Documents/Nessie`: the person's mirror, deliberately not the agents' `~/Nessie`. */
export const defaultFolderSyncRoot = (home = homedir()): string => join(home, 'Documents', 'Nessie')

/** The only part of the host path that leaves the machine. */
export const folderSyncRootLabel = (root: string): string => basename(resolve(root))

// ── The folder's marker ─────────────────────────────────────────────────────

/**
 * `<root>/.nessie-sync-<executorId>`: which sync owns which team folder in this
 * root. One file per executor, so several teams share one root without
 * writing one another's marker. A missing marker is `root_missing` (C21);
 * a moved folder with its marker intact resumes.
 */
export type FolderSyncMarker = { syncId: string; executorId: string; teamFolder: string | null; createdAt: string }

const MARKER_PREFIX = '.nessie-sync-'
const MARKER_NAME = /^\.nessie-sync-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** A sync's marker (not the engine's own `.nessie-sync-move-…`, `-part-…` or `-aside-…` siblings). */
export const isSyncMarkerName = (name: string): boolean => MARKER_NAME.test(name)

export const markerPath = (root: string, executorId: string): string => join(root, `${MARKER_PREFIX}${executorId}`)

export const readMarker = async (root: string, executorId: string): Promise<FolderSyncMarker | null> => {
  try {
    const parsed = JSON.parse(await readFile(fsPath(markerPath(root, executorId)), 'utf8')) as FolderSyncMarker
    return parsed.executorId === executorId && typeof parsed.syncId === 'string' ? parsed : null
  } catch {
    return null
  }
}

export const writeMarker = async (root: string, marker: FolderSyncMarker): Promise<void> => {
  const path = markerPath(root, marker.executorId)
  const temporary = `${path}.${randomUUID().slice(0, 8)}.new`
  await writeNewFile(temporary, new TextEncoder().encode(`${JSON.stringify(marker)}\n`))
  await rename(fsPath(temporary), fsPath(path))
}

/** Team folders other syncs in this root hold: a new team folder must not take one. */
export const teamFoldersOfOtherSyncs = async (root: string, executorId: string): Promise<string[]> => {
  const names = await readdir(fsPath(root)).catch(() => [] as string[])
  const taken: string[] = []
  for (const name of names) {
    if (!name.startsWith(MARKER_PREFIX) || name === `${MARKER_PREFIX}${executorId}`) continue
    const other = await readMarker(root, name.slice(MARKER_PREFIX.length))
    if (other?.teamFolder) taken.push(other.teamFolder)
  }
  return taken
}

// ── The root rule ───────────────────────────────────────────────────────────

const caseFolded = (path: string): string =>
  process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path

const inside = (parent: string, child: string): boolean => {
  const path = relative(caseFolded(parent), caseFolded(child))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

const overlaps = (a: string, b: string): boolean => inside(a, b) || inside(b, a)

const real = (path: string): Promise<string> => realpath(path).catch(() => resolve(path))

/** True when a marker beside `root` or above it names a team folder of another sync that holds `root`. */
const insideAnotherSync = async (root: string, executorId: string): Promise<boolean> => {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const names = await readdir(fsPath(dir)).catch(() => [] as string[])
    for (const name of names) {
      if (!isSyncMarkerName(name) || name === `${MARKER_PREFIX}${executorId}`) continue
      const other = await readMarker(dir, name.slice(MARKER_PREFIX.length))
      if (other?.teamFolder && inside(join(dir, other.teamFolder), root)) return true
    }
    if (dirname(dir) === dir) return false
  }
}

/**
 * Why `root` cannot be the sync folder, or null when it can: absolute, an
 * existing writable directory that is not a link, not inside, equal to or
 * containing any workspace folder (agents' reach) or the agents' `~/Nessie`,
 * nowhere near the executor's state, and not inside another team's synced
 * folder on this computer (that sync would send this team's files to its own
 * team, and this one the other's).
 */
export const syncRootRefusal = async (
  root: string,
  context: {
    workspaceFolders: readonly ExecutorWorkspaceFolder[]; stateDir: string; executorId: string; home?: string
  },
): Promise<FolderSyncConsoleRefusal | null> => {
  if (!isAbsolute(root)) return 'root_not_absolute'
  const found = await lstatOrNull(resolve(root))
  if (found === null) return 'root_missing'
  if (found.type === 'link') return 'root_is_link'
  if (found.type !== 'directory') return 'root_not_a_directory'
  const rootReal = await real(root)
  const home = context.home ?? homedir()
  const agentFolders = [...context.workspaceFolders.map((folder) => folder.path), join(home, 'Nessie')]
  for (const folder of agentFolders) {
    if (overlaps(rootReal, await real(folder)) || overlaps(resolve(root), resolve(folder))) {
      return 'root_overlaps_workspace_folder'
    }
  }
  const stateRoot = dirname(resolve(context.stateDir))
  if (overlaps(rootReal, await real(stateRoot)) || overlaps(resolve(root), stateRoot)) {
    return 'root_inside_state_directory'
  }
  if (await insideAnotherSync(root, context.executorId) || await insideAnotherSync(rootReal, context.executorId)) {
    return 'root_inside_other_sync'
  }
  if (!await directoryWritable(resolve(root))) return 'root_not_writable'
  return null
}

/** Files already in a folder with no marker of ours (C22): ask before they go to Nessie. */
export const countExistingFiles = async (root: string, limit = 100_000): Promise<number> => {
  let count = 0
  const walk = async (directory: string): Promise<void> => {
    const names = await readdir(fsPath(directory)).catch(() => [] as string[])
    for (const name of names) {
      if (count >= limit || isIgnoredName(name)) continue
      const path = join(directory, name)
      const found = await lstatOrNull(path)
      if (found?.type === 'file') count += 1
      else if (found?.type === 'directory') await walk(path)
    }
  }
  await walk(root)
  return count
}

/**
 * Make the default root on first use — the switch turned on with no folder
 * chosen sends it. Only a missing folder is created; whatever already holds
 * the name (a file, a link) is left alone for the root rule to refuse. Any
 * other root must already exist.
 */
export const prepareDefaultRoot = async (root: string, home = homedir()): Promise<void> => {
  if (resolve(root) !== resolve(defaultFolderSyncRoot(home)) || await lstatOrNull(root) !== null) return
  await mkdir(fsPath(root), { recursive: true }).catch(() => undefined)
}
