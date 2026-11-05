import type { FolderSyncCursors } from '@nessie/executor-protocol'

import { EMPTY_MANIFEST } from './reconcile-manifest.js'
import type { RemoteManifest } from './reconcile-model.js'
import type { ReconcileAction, SyncEntry } from './types.js'

/**
 * The engine's durable local state (plan §2.4, amendments A7, A8, A12.7),
 * kept under `<stateDir>/folder-sync/`:
 *
 * - `index.json` — entries, the server manifest, the journal cursors, the
 *   conflict ids already told, the merge bases held, and the actions that were
 *   started but not finished. Written whole and atomically. The cursors are
 *   in the same write as the manifest they imply (A12.7), so there is no
 *   separate `cursors.json`.
 * - `journal.ndjson` — one record per line, appended and flushed before the
 *   side effect it announces; replayed at start onto the index and folded
 *   into it by compaction. Every record carries a sequence number, and the
 *   index remembers the last one it folded in, so a crash between writing the
 *   index and truncating the journal replays nothing twice.
 * - `bases/<pageId>` — the base text of a mergeable entry (A7), replaced when
 *   its base advances. The index names the hash each one holds.
 *
 * All file I/O goes through `IndexStorePort`: this module has no `node:fs`.
 */

export const INDEX_FORMAT_VERSION = 1
/** Compact once the journal holds this many records. */
export const JOURNAL_COMPACT_RECORDS = 1_000

export type IndexFileName = 'index.json' | 'journal.ndjson'

/** The only way this module touches the disk; the engine implements it owner-only. */
export type IndexStorePort = {
  /** The file's text, or null when it does not exist. */
  read(name: IndexFileName): Promise<string | null>
  /** Replace the file atomically (write a sibling, flush, rename). */
  replace(name: IndexFileName, text: string): Promise<void>
  /** Append to the file and flush before resolving. */
  append(name: 'journal.ndjson', text: string): Promise<void>
  readBase(pageId: string): Promise<Uint8Array | null>
  /** Replace a base atomically. */
  writeBase(pageId: string, bytes: Uint8Array): Promise<void>
  removeBase(pageId: string): Promise<void>
}

/**
 * A8: a download about to replace its target. Written after the `.part`
 * verified and the target was re-checked, immediately before the rename. If
 * the engine stops between the rename and `done`, replay finds the record and
 * decides by the target's hash (`resolveInstall`).
 */
export type InstallRecord = {
  actionId: string
  pageId: string
  versionId: string
  revision: number
  hash: string
  relPath: string
}

export type JournalRecord =
  | { seq: number; op: 'action'; actionId: string; action: ReconcileAction }
  | { seq: number; op: 'done'; actionId: string }
  | ({ seq: number; op: 'install' } & InstallRecord)
  | { seq: number; op: 'entry'; entry: SyncEntry }
  | { seq: number; op: 'forget'; pageId: string }
  | { seq: number; op: 'conflicts'; clientConflictIds: string[] }
  | { seq: number; op: 'base'; pageId: string; contentHash: string | null }

type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never

export type IndexFile = {
  version: typeof INDEX_FORMAT_VERSION
  /** The last journal record folded into this file. */
  journalSeq: number
  entries: SyncEntry[]
  manifest: RemoteManifest
  cursors: FolderSyncCursors
  knownConflictIds: string[]
  /** Page id → the hash of the base text `bases/<pageId>` holds. */
  bases: Record<string, string>
  /** Started, not finished: replayed (each re-checks its expectation). */
  pending: Array<{ actionId: string; action: ReconcileAction }>
  installs: InstallRecord[]
  /**
   * Space id → the directory that last held it here. A space's directory is
   * renamed or removed from this, not from its entries, so an empty one is too.
   */
  spaceDirs: Record<string, string>
}

export const emptyIndex = (): IndexFile => ({
  version: INDEX_FORMAT_VERSION,
  journalSeq: 0,
  entries: [],
  manifest: EMPTY_MANIFEST,
  cursors: {},
  knownConflictIds: [],
  bases: {},
  pending: [],
  installs: [],
  spaceDirs: {},
})

/** Apply one record to the index in memory. Idempotent for a record already applied. */
export const applyRecord = (index: IndexFile, record: JournalRecord): IndexFile => {
  if (record.seq <= index.journalSeq) return index
  const next: IndexFile = { ...index, journalSeq: record.seq }
  switch (record.op) {
    case 'action':
      next.pending = [...index.pending.filter((p) => p.actionId !== record.actionId), {
        actionId: record.actionId, action: record.action,
      }]
      break
    case 'done':
      next.pending = index.pending.filter((p) => p.actionId !== record.actionId)
      next.installs = index.installs.filter((install) => install.actionId !== record.actionId)
      break
    case 'install': {
      const install: InstallRecord = {
        actionId: record.actionId,
        pageId: record.pageId,
        versionId: record.versionId,
        revision: record.revision,
        hash: record.hash,
        relPath: record.relPath,
      }
      next.installs = [...index.installs.filter((i) => i.actionId !== record.actionId), install]
      break
    }
    case 'entry':
      next.entries = [...index.entries.filter((e) => e.pageId !== record.entry.pageId), record.entry]
      break
    case 'forget':
      next.entries = index.entries.filter((entry) => entry.pageId !== record.pageId)
      break
    case 'conflicts':
      next.knownConflictIds = [...new Set([...index.knownConflictIds, ...record.clientConflictIds])]
      break
    case 'base': {
      const bases = { ...index.bases }
      if (record.contentHash === null) delete bases[record.pageId]
      else bases[record.pageId] = record.contentHash
      next.bases = bases
      break
    }
  }
  return next
}

export class IndexCorruptError extends Error {}

/**
 * Parse the journal. A last line without its newline, or that does not parse,
 * is a torn append from a crash and is dropped — its side effect never
 * started, because the append is flushed first. A bad line anywhere else is
 * corruption, and nothing is guessed.
 */
export const parseJournal = (text: string): JournalRecord[] => {
  const lines = text.split('\n')
  const torn = lines.pop()!
  const records: JournalRecord[] = []
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line) as JournalRecord)
    } catch {
      const last = index === lines.length - 1 && torn === ''
      if (!last) throw new IndexCorruptError(`journal.ndjson line ${index + 1} is not JSON.`)
    }
  }
  return records
}

export const parseIndex = (text: string | null): IndexFile => {
  if (text === null) return emptyIndex()
  let parsed: IndexFile
  try {
    parsed = JSON.parse(text) as IndexFile
  } catch {
    throw new IndexCorruptError('index.json is not JSON.')
  }
  if (parsed.version !== INDEX_FORMAT_VERSION) {
    throw new IndexCorruptError(`index.json has format ${String(parsed.version)}, expected ${INDEX_FORMAT_VERSION}.`)
  }
  // An index written before space directories were kept knows none.
  return { ...parsed, spaceDirs: parsed.spaceDirs ?? {} }
}

/**
 * A8 replay: an install whose `done` never came. When the target holds the
 * installed hash the rename happened and only the bookkeeping is missing
 * (`completed`: record the entry at that version). Otherwise the rename did
 * not happen, or the file changed since — the download is not applied and the
 * entry is planned again from what is on disk, so nothing is overwritten.
 */
export const resolveInstall = (install: InstallRecord, targetHash: string | null): 'completed' | 'not_applied' =>
  targetHash === install.hash ? 'completed' : 'not_applied'

export class FolderSyncIndexStore {
  private journalRecords = 0

  private constructor(private readonly port: IndexStorePort, private current: IndexFile) {}

  /** Read the index, replay the journal onto it, and fold the result in. */
  static async open(port: IndexStorePort): Promise<FolderSyncIndexStore> {
    let index = parseIndex(await port.read('index.json'))
    for (const record of parseJournal((await port.read('journal.ndjson')) ?? '')) index = applyRecord(index, record)
    const store = new FolderSyncIndexStore(port, index)
    await store.compact()
    return store
  }

  get index(): Readonly<IndexFile> {
    return this.current
  }

  /** Pages whose stored base text is their entry's current base: the reconciler's `mergeBases`. */
  mergeBases(): Set<string> {
    return new Set(this.current.entries
      .filter((entry) => entry.base.contentHash !== null && this.current.bases[entry.pageId] === entry.base.contentHash)
      .map((entry) => entry.pageId))
  }

  private async append(record: WithoutSeq<JournalRecord>): Promise<number> {
    const seq = this.current.journalSeq + 1
    const full = { ...record, seq } as JournalRecord
    await this.port.append('journal.ndjson', `${JSON.stringify(full)}\n`)
    this.current = applyRecord(this.current, full)
    this.journalRecords += 1
    if (this.journalRecords >= JOURNAL_COMPACT_RECORDS) await this.compact()
    return seq
  }

  /** Journal an action before its side effect; returns its id for `finish`. */
  async begin(action: ReconcileAction): Promise<string> {
    const actionId = `a${this.current.journalSeq + 1}`
    await this.append({ op: 'action', actionId, action })
    return actionId
  }

  async finish(actionId: string): Promise<void> {
    await this.append({ op: 'done', actionId })
  }

  async install(install: InstallRecord): Promise<void> {
    await this.append({ op: 'install', ...install })
  }

  async putEntry(entry: SyncEntry): Promise<void> {
    await this.append({ op: 'entry', entry })
  }

  async forget(pageId: string): Promise<void> {
    await this.append({ op: 'forget', pageId })
  }

  async rememberConflicts(clientConflictIds: string[]): Promise<void> {
    if (clientConflictIds.length > 0) await this.append({ op: 'conflicts', clientConflictIds })
  }

  /** A7: hold the base text for `pageId` (null drops it). The bytes land before the index names them. */
  async setBase(pageId: string, base: { bytes: Uint8Array; contentHash: string } | null): Promise<void> {
    if (base) await this.port.writeBase(pageId, base.bytes)
    await this.append({ op: 'base', pageId, contentHash: base?.contentHash ?? null })
    if (!base) await this.port.removeBase(pageId)
  }

  /** The base text for a merge, only when it is the base the entry names; null otherwise (R2). */
  async readBase(pageId: string, contentHash: string): Promise<Uint8Array | null> {
    if (this.current.bases[pageId] !== contentHash) return null
    return this.port.readBase(pageId)
  }

  /** A new manifest and the cursors it implies, written in one index write (A12.7). */
  async replaceManifest(manifest: RemoteManifest, cursors: FolderSyncCursors): Promise<void> {
    this.current = { ...this.current, manifest, cursors }
    await this.compact()
  }

  /** Where each space's directory is now; written only when it changed. */
  async setSpaceDirs(spaceDirs: Record<string, string>): Promise<void> {
    if (JSON.stringify(spaceDirs) === JSON.stringify(this.current.spaceDirs)) return
    this.current = { ...this.current, spaceDirs }
    await this.compact()
  }

  /** Fold the journal into `index.json`, then empty the journal. */
  async compact(): Promise<void> {
    await this.port.replace('index.json', JSON.stringify(this.current))
    await this.port.replace('journal.ndjson', '')
    this.journalRecords = 0
  }
}
