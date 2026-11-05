import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { replaceOwnerOnlyJson, replaceOwnerOnlyText } from '../owner-only-json.js'
import { ensureOwnerOnlyStateDirectory, type StateSecurityDeps } from '../state-security.js'
import type { IndexFileName, IndexStorePort } from './index-store.js'

/**
 * Where folder sync keeps its own state: `<stateDir>/folder-sync/`, owner-only,
 * never inside the person's folder (plan §2.4). Everything the engine, the CLI
 * and the console read or write locally is named here.
 */

export type FolderSyncPaths = {
  dir: string
  /** The switch, the root and the folder's identity (`config.ts`). */
  config: string
  /** What the engine last decided, for the console (`console-state.ts`). */
  status: string
  /** Conflict rows: open ones for the console, unreported ones for the next report. */
  conflicts: string
  /** Console choices waiting for the engine, one file each: resolutions and held-delete decisions. */
  requests: string
  /** Local recycle copies, `<yyyy-mm-dd>/<relPath>`, kept 30 days. */
  trash: string
  /** In-flight downloads, `<pageId>.<versionId>.part`. */
  pending: string
  /** Merge base texts (A7), `<pageId>`. */
  bases: string
}

export const folderSyncPaths = (stateDir: string): FolderSyncPaths => {
  const dir = join(stateDir, 'folder-sync')
  return {
    dir,
    config: join(dir, 'config.json'),
    status: join(dir, 'status.json'),
    conflicts: join(dir, 'conflicts.json'),
    requests: join(dir, 'requests'),
    trash: join(dir, 'trash'),
    pending: join(dir, 'pending'),
    bases: join(dir, 'bases'),
  }
}

/** Create the owner-only directories (idempotent). */
export const ensureFolderSyncDirectories = async (
  paths: FolderSyncPaths,
  security: StateSecurityDeps = {},
): Promise<void> => {
  await ensureOwnerOnlyStateDirectory(paths.dir, security)
  for (const child of [paths.trash, paths.pending, paths.bases, paths.requests]) await mkdir(child, { recursive: true })
}

const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** A small owner-only JSON file, or `fallback` when it does not exist yet. */
export const readStateJson = async <T>(path: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if (absent(error)) return fallback
    throw error
  }
}

export const writeStateJson = (path: string, value: unknown, security: StateSecurityDeps = {}): Promise<void> =>
  replaceOwnerOnlyJson(path, value, security)

/** A choice the console made, for the engine to carry out on its next pass. */
export type ConsoleRequest =
  | { kind: 'resolve'; clientConflictId: string; resolution: 'keep_mine' | 'keep_nessie' | 'dismiss' }
  | { kind: 'held_deletes'; batchId: string; decision: 'confirm' | 'restore' }

export const queueConsoleRequest = async (
  paths: FolderSyncPaths, request: ConsoleRequest, security: StateSecurityDeps = {},
): Promise<void> => {
  await mkdir(paths.requests, { recursive: true })
  await writeStateJson(join(paths.requests, `${Date.now()}-${randomUUID()}.json`), request, security)
}

/** Every queued request, oldest first; each is removed once read. */
export const takeConsoleRequests = async (paths: FolderSyncPaths): Promise<ConsoleRequest[]> => {
  const names = (await readdir(paths.requests).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort()
  const requests: ConsoleRequest[] = []
  for (const name of names) {
    const path = join(paths.requests, name)
    requests.push(await readStateJson<ConsoleRequest>(path, null as unknown as ConsoleRequest))
    await rm(path, { force: true })
  }
  return requests.filter(Boolean)
}

/** The index store's disk: atomic replaces, flushed appends, and the base texts. */
export const createIndexStorePort = (paths: FolderSyncPaths, security: StateSecurityDeps = {}): IndexStorePort => {
  const file = (name: IndexFileName) => join(paths.dir, name)
  const base = (pageId: string) => {
    if (!/^[0-9a-f-]{36}$/iu.test(pageId)) throw new Error('A base is named by a page id.')
    return join(paths.bases, pageId)
  }
  return {
    read: async (name) => {
      try {
        return await readFile(file(name), 'utf8')
      } catch (error) {
        if (absent(error)) return null
        throw error
      }
    },
    replace: (name, text) => replaceOwnerOnlyText(file(name), text, security),
    append: async (name, text) => {
      const handle = await open(file(name), 'a', 0o600)
      try {
        await handle.writeFile(text, 'utf8')
        await handle.datasync()
      } finally {
        await handle.close()
      }
    },
    readBase: async (pageId) => {
      try {
        return new Uint8Array(await readFile(base(pageId)))
      } catch (error) {
        if (absent(error)) return null
        throw error
      }
    },
    writeBase: async (pageId, bytes) => {
      const target = base(pageId)
      const handle = await open(`${target}.new`, 'w', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(`${target}.new`, target)
    },
    removeBase: (pageId) => rm(base(pageId), { force: true }),
  }
}
