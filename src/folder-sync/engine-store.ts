import type { FolderSyncCursors } from '@nessie/executor-protocol'

import { FolderSyncIndexStore, type InstallRecord, type IndexStorePort } from './index-store.js'
import { isWithin } from './path-mapping.js'
import type { RemoteManifest } from './reconcile-model.js'
import type { ReconcileAction, SyncEntry } from './types.js'

/**
 * The index store as the engine uses it: one writer at a time (concurrent
 * transfers share it, and every journal record takes the next sequence
 * number), with the entries indexed by page for the action runner.
 */
export class EngineStore {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly byPage = new Map<string, SyncEntry>()

  private constructor(private readonly store: FolderSyncIndexStore) {
    for (const entry of store.index.entries) this.byPage.set(entry.pageId, entry)
  }

  static async open(port: IndexStorePort): Promise<EngineStore> {
    return new EngineStore(await FolderSyncIndexStore.open(port))
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  get index() {
    return this.store.index
  }

  entries(): SyncEntry[] {
    return [...this.byPage.values()]
  }

  entry(pageId: string): SyncEntry | undefined {
    return this.byPage.get(pageId)
  }

  entryAt(relPath: string): SyncEntry | undefined {
    for (const entry of this.byPage.values()) if (entry.relPath === relPath) return entry
    return undefined
  }

  /** Entries at or below `relPath`. */
  entriesWithin(relPath: string): SyncEntry[] {
    return [...this.byPage.values()].filter((entry) => isWithin(entry.relPath, relPath))
  }

  mergeBases(): Set<string> {
    return this.store.mergeBases()
  }

  put(entry: SyncEntry): Promise<void> {
    this.byPage.set(entry.pageId, entry)
    return this.serial(() => this.store.putEntry(entry))
  }

  /** Forget an entry and drop the base text it held. */
  forget(pageId: string): Promise<void> {
    this.byPage.delete(pageId)
    return this.serial(async () => {
      await this.store.forget(pageId)
      if (this.store.index.bases[pageId] !== undefined) await this.store.setBase(pageId, null)
    })
  }

  begin(action: ReconcileAction): Promise<string> {
    return this.serial(() => this.store.begin(action))
  }

  finish(actionId: string): Promise<void> {
    return this.serial(() => this.store.finish(actionId))
  }

  install(record: InstallRecord): Promise<void> {
    return this.serial(() => this.store.install(record))
  }

  setBase(pageId: string, base: { bytes: Uint8Array; contentHash: string } | null): Promise<void> {
    return this.serial(async () => {
      if (base === null && this.store.index.bases[pageId] === undefined) return
      await this.store.setBase(pageId, base)
    })
  }

  readBase(pageId: string, contentHash: string): Promise<Uint8Array | null> {
    return this.serial(() => this.store.readBase(pageId, contentHash))
  }

  rememberConflicts(ids: string[]): Promise<void> {
    return this.serial(() => this.store.rememberConflicts(ids))
  }

  replaceManifest(manifest: RemoteManifest, cursors: FolderSyncCursors): Promise<void> {
    return this.serial(() => this.store.replaceManifest(manifest, cursors))
  }

  setSpaceDirs(spaceDirs: Record<string, string>): Promise<void> {
    return this.serial(() => this.store.setSpaceDirs(spaceDirs))
  }
}
