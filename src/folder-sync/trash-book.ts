import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { StateSecurityDeps } from '../state-security.js'
import { freePath } from './reconcile-model.js'
import { confinedPath, fsPath, lstatOrNull, moveIntoFolder } from './local-fs.js'
import { nameKey, parentPath } from './path-mapping.js'
import { readStateJson, writeStateJson, type FolderSyncPaths } from './state-files.js'

/**
 * Deleted files (plan §5.2): what folder sync put in its trash, so the
 * console can list it and put one back. Each trashed item gets one record
 * file under `trash/.entries/`, named by an opaque id — one file each, so the
 * engine adding and the console restoring never write the same file. A record
 * whose item the 30-day sweep removed is dropped when the list is read.
 * Restoring moves the item back into the team folder (beside anything now at
 * its path, never over it); the engine's next pass sends it to Nessie as a
 * new page or a new version.
 */

export type TrashEntry = {
  entryId: string
  /** Where it was, relative to the team folder. */
  relPath: string
  deletedAt: string
}

type TrashRecord = TrashEntry & { trashPath: string }

const entriesDir = (paths: FolderSyncPaths) => join(paths.trash, '.entries')
const ENTRY_ID = /^[0-9a-f-]{36}$/u

export const recordTrashed = async (
  paths: FolderSyncPaths, relPath: string, trashPath: string, now: number, security: StateSecurityDeps = {},
): Promise<void> => {
  await mkdir(entriesDir(paths), { recursive: true })
  const entryId = randomUUID()
  const record: TrashRecord = { entryId, relPath, deletedAt: new Date(now).toISOString(), trashPath }
  await writeStateJson(join(entriesDir(paths), `${entryId}.json`), record, security)
}

const records = async (paths: FolderSyncPaths): Promise<TrashRecord[]> => {
  const names = await readdir(entriesDir(paths)).catch(() => [] as string[])
  const found: TrashRecord[] = []
  for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
    const record = await readStateJson<TrashRecord | null>(join(entriesDir(paths), name), null)
    if (record && await lstatOrNull(record.trashPath) !== null) found.push(record)
    else await rm(join(entriesDir(paths), name), { force: true })
  }
  return found
}

/** The trash, newest first. */
export const listTrash = async (paths: FolderSyncPaths): Promise<TrashEntry[]> =>
  (await records(paths))
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
    .map(({ entryId, relPath, deletedAt }) => ({ entryId, relPath, deletedAt }))

/** Put an entry back in the team folder; false when no such entry is in the trash. */
export const restoreTrashed = async (paths: FolderSyncPaths, teamDir: string, entryId: string): Promise<boolean> => {
  if (!ENTRY_ID.test(entryId)) return false
  const record = (await records(paths)).find((candidate) => candidate.entryId === entryId)
  if (!record) return false
  const dir = parentPath(record.relPath)
  const siblings = await readdir(fsPath(dir === '' ? teamDir : confinedPath(teamDir, dir))).catch(() => [] as string[])
  const occupied = new Set(siblings.map((name) => nameKey(dir === '' ? name : `${dir}/${name}`)))
  const target = freePath(record.relPath, occupied)
  await moveIntoFolder(teamDir, record.trashPath, confinedPath(teamDir, target))
  await rm(join(entriesDir(paths), `${entryId}.json`), { force: true })
  return true
}
