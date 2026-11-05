import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FolderSyncIndexStore,
  IndexCorruptError,
  JOURNAL_COMPACT_RECORDS,
  applyRecord,
  emptyIndex,
  parseJournal,
  resolveInstall,
  type IndexFileName,
  type IndexStorePort,
} from '../src/folder-sync/index-store.js'
import type { ReconcileAction, SyncEntry } from '../src/folder-sync/types.js'

/** An in-memory disk that can stop between any two writes. */
class MemoryPort implements IndexStorePort {
  files = new Map<string, string>()
  bases = new Map<string, Uint8Array>()
  writes = 0
  /** Throw on the Nth write from now (simulating a crash before it). */
  crashAt: number | null = null

  private tick(): void {
    if (this.crashAt !== null && this.writes >= this.crashAt) throw new Error('crash')
    this.writes += 1
  }

  async read(name: IndexFileName) { return this.files.get(name) ?? null }
  async replace(name: IndexFileName, text: string) { this.tick(); this.files.set(name, text) }
  async append(name: 'journal.ndjson', text: string) { this.tick(); this.files.set(name, (this.files.get(name) ?? '') + text) }
  async readBase(pageId: string) { return this.bases.get(pageId) ?? null }
  async writeBase(pageId: string, bytes: Uint8Array) { this.tick(); this.bases.set(pageId, bytes) }
  async removeBase(pageId: string) { this.tick(); this.bases.delete(pageId) }
}

const PAGE = '20000000-0000-4000-8000-000000000001'
const HASH = `sha256:${'a'.repeat(64)}`
const entry = (overrides: Partial<SyncEntry> = {}): SyncEntry => ({
  pageId: PAGE,
  spaceId: '10000000-0000-4000-8000-000000000001',
  kind: 'document',
  relPath: 'Space/Plan.md',
  parentPageId: null,
  title: 'Plan',
  base: { versionId: '30000000-0000-4000-8000-000000000001', revision: 1, contentHash: HASH },
  local: null,
  remote: null,
  state: 'synced',
  ...overrides,
})
const mkdir: ReconcileAction = { type: 'mkdir', pageId: PAGE, relPath: 'Space/Folder' }

test('a fresh store is empty and writes its index', async () => {
  const port = new MemoryPort()
  const store = await FolderSyncIndexStore.open(port)
  assert.deepEqual(store.index.entries, [])
  assert.ok(port.files.has('index.json'))
  assert.equal(port.files.get('journal.ndjson'), '')
})

test('records are journaled before they count, and survive a restart without compaction', async () => {
  const port = new MemoryPort()
  const store = await FolderSyncIndexStore.open(port)
  await store.putEntry(entry())
  const id = await store.begin(mkdir)
  assert.equal(port.files.get('journal.ndjson')!.trim().split('\n').length, 2)
  const reopened = await FolderSyncIndexStore.open(port)
  assert.equal(reopened.index.entries.length, 1)
  assert.deepEqual(reopened.index.pending, [{ actionId: id, action: mkdir }])
  await reopened.finish(id)
  assert.deepEqual(reopened.index.pending, [])
})

test('crash replay: an action begun and never finished is pending after restart', async () => {
  const port = new MemoryPort()
  const store = await FolderSyncIndexStore.open(port)
  await store.begin(mkdir)
  port.crashAt = port.writes
  await assert.rejects(store.finish('a1'))
  port.crashAt = null
  const reopened = await FolderSyncIndexStore.open(port)
  assert.equal(reopened.index.pending.length, 1)
})

test('a torn last line is dropped; a bad line in the middle is corruption', () => {
  const good = JSON.stringify({ seq: 1, op: 'forget', pageId: PAGE })
  assert.equal(parseJournal(`${good}\n{"seq":2,"op":"forg`).length, 1)
  assert.equal(parseJournal(`${good}\n{"seq":2,"op":"forg\n`).length, 1)
  assert.throws(() => parseJournal(`${good}\nnot json\n${good}\n`), IndexCorruptError)
})

test('replaying records already folded into the index changes nothing (crash between index write and truncate)', async () => {
  const port = new MemoryPort()
  const store = await FolderSyncIndexStore.open(port)
  await store.putEntry(entry())
  await store.forget(PAGE)
  const journal = port.files.get('journal.ndjson')!
  await store.compact()
  port.files.set('journal.ndjson', journal)
  const reopened = await FolderSyncIndexStore.open(port)
  assert.deepEqual(reopened.index.entries, [])
  let index = emptyIndex()
  const record = { seq: 1, op: 'entry' as const, entry: entry() }
  index = applyRecord(applyRecord(index, record), record)
  assert.equal(index.entries.length, 1)
})

test('compaction folds the journal in after enough records', async () => {
  const port = new MemoryPort()
  const store = await FolderSyncIndexStore.open(port)
  for (let n = 0; n < JOURNAL_COMPACT_RECORDS; n += 1) await store.putEntry(entry({ title: `Plan ${n}` }))
  assert.equal(port.files.get('journal.ndjson'), '')
  const index = JSON.parse(port.files.get('index.json')!)
  assert.equal(index.entries[0].title, `Plan ${JOURNAL_COMPACT_RECORDS - 1}`)
  assert.equal(index.journalSeq, JOURNAL_COMPACT_RECORDS)
})

test('A12.7: a manifest and its cursors land in one index write', async () => {
  const port = new MemoryPort()
  const store = await FolderSyncIndexStore.open(port)
  const writes = port.writes
  await store.replaceManifest({ snapshotAt: '2026-11-03T00:00:00.000Z', spaces: [], excludedSpaceIds: [], pages: [] }, {
    '10000000-0000-4000-8000-000000000001': '42',
  })
  const index = JSON.parse(port.files.get('index.json')!)
  assert.equal(index.cursors['10000000-0000-4000-8000-000000000001'], '42')
  assert.equal(index.manifest.snapshotAt, '2026-11-03T00:00:00.000Z')
  assert.equal(port.writes - writes, 2)
})

test('A7: the base store returns text only for the base the entry names', async () => {
  const port = new MemoryPort()
  const store = await FolderSyncIndexStore.open(port)
  await store.putEntry(entry())
  await store.setBase(PAGE, { bytes: new TextEncoder().encode('base text'), contentHash: HASH })
  assert.deepEqual(store.mergeBases(), new Set([PAGE]))
  assert.equal(new TextDecoder().decode((await store.readBase(PAGE, HASH))!), 'base text')
  assert.equal(await store.readBase(PAGE, `sha256:${'b'.repeat(64)}`), null)
  await store.putEntry(entry({ base: { versionId: null, revision: 2, contentHash: `sha256:${'b'.repeat(64)}` } }))
  assert.deepEqual(store.mergeBases(), new Set())
  await store.setBase(PAGE, null)
  assert.equal(port.bases.has(PAGE), false)
  assert.equal(await store.readBase(PAGE, HASH), null)
})

test('A7: a crash after writing base bytes but before naming them leaves no base in use', async () => {
  const port = new MemoryPort()
  const store = await FolderSyncIndexStore.open(port)
  await store.putEntry(entry())
  port.crashAt = port.writes + 1
  await assert.rejects(store.setBase(PAGE, { bytes: new Uint8Array([1]), contentHash: HASH }))
  port.crashAt = null
  const reopened = await FolderSyncIndexStore.open(port)
  assert.deepEqual(reopened.mergeBases(), new Set())
})

test('A8: an install without done is resolved by the target\'s hash after a crash', async () => {
  const port = new MemoryPort()
  const store = await FolderSyncIndexStore.open(port)
  const id = await store.begin({
    type: 'download', pageId: PAGE, versionId: '30000000-0000-4000-8000-000000000002', relPath: 'Space/Plan.md',
    contentHash: HASH, byteLength: 3, readOnly: false, expect: { base: null, local: null },
  })
  const install = {
    actionId: id, pageId: PAGE, versionId: '30000000-0000-4000-8000-000000000002', revision: 2, hash: HASH,
    relPath: 'Space/Plan.md',
  }
  await store.install(install)
  const reopened = await FolderSyncIndexStore.open(port)
  assert.deepEqual(reopened.index.installs, [install])
  assert.equal(resolveInstall(install, HASH), 'completed')
  assert.equal(resolveInstall(install, `sha256:${'c'.repeat(64)}`), 'not_applied')
  assert.equal(resolveInstall(install, null), 'not_applied')
  await reopened.finish(id)
  assert.deepEqual(reopened.index.installs, [])
  assert.deepEqual(reopened.index.pending, [])
})

test('conflict ids accumulate without duplicates', async () => {
  const store = await FolderSyncIndexStore.open(new MemoryPort())
  await store.rememberConflicts(['x', 'y'])
  await store.rememberConflicts(['y', 'z'])
  assert.deepEqual(store.index.knownConflictIds, ['x', 'y', 'z'])
})

test('an index of another format version is refused', async () => {
  const port = new MemoryPort()
  port.files.set('index.json', JSON.stringify({ version: 99 }))
  await assert.rejects(FolderSyncIndexStore.open(port), IndexCorruptError)
})
