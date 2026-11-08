import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { CodexRetainedCatalog, type CodexCatalogRow } from '../../src/t3-session/native-sources/codex/catalog.js'
import { codexAssociationCandidates, codexIdentity, codexIdentityKey } from '../../src/t3-session/native-sources/codex/identity.js'
import { readCodexIndexPage, type CodexIndexCursor } from '../../src/t3-session/native-sources/codex/index-reader.js'

const home = { executorId: 'computer:a', continuationHomeKey: 'physical:shared', historyHomeKey: 'history:shared' }
const watermark = 'capture:one'
const candidate = (nativeId: string, state: CodexCatalogRow['state'] = 'active'): CodexCatalogRow => ({
  identity: codexIdentity(home, nativeId), title: 'Stejný název', createdAt: 1, updatedAt: 2,
  state, historyReferences: [`resource:${nativeId}`],
})
const append = (catalog: CodexRetainedCatalog, part: 'state-index' | 'sessions' | 'archived-sessions',
  rows: CodexCatalogRow[] = []) => catalog.append(part, { watermark, cursor: null, nextCursor: null, rows })

test('complete native index pages include old, archived, empty threads and more than 5,000 rows', () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER,
      archived INTEGER, rollout_path TEXT, tokens_used INTEGER);
      CREATE TABLE credentials (secret TEXT); INSERT INTO credentials VALUES ('not-selected')`)
    const insert = database.prepare('INSERT INTO threads VALUES (?, ?, 1, 2, ?, ?, 999999)')
    for (let index = 0; index < 5101; index++) insert.run(`native:${String(index).padStart(5, '0')}`, '', index % 2, '')
    const statements: string[] = []
    const readonly = { prepare(sql: string) {
      statements.push(sql)
      return { all: (...args: (string | number)[]) => database.prepare(sql).all(...args) }
    } }
    const ids: string[] = []
    let cursor: CodexIndexCursor | undefined
    do {
      const page = readCodexIndexPage(readonly, home, watermark, { limit: 97, cursor })
      assert.equal(page.inventoryComplete, false, 'rollout enumeration remains required')
      ids.push(...page.entries.map(entry => entry.identity.nativeId))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    assert.equal(ids.length, 5101)
    assert.equal(new Set(ids).size, 5101)
    assert.equal(ids[0], 'native:05100')
    assert.equal(ids.at(-1), 'native:00000')
    assert.ok(statements.every(sql => !sql.includes('tokens_used') && !sql.includes('credentials') && !sql.includes('SELECT *')))
    const first = readCodexIndexPage(readonly, home, watermark, { limit: 1 })
    assert.throws(() => readCodexIndexPage(readonly, home, 'new', { cursor: first.nextCursor! }), /codex_cursor_stale/u)
    assert.throws(() => readCodexIndexPage(readonly, { ...home, executorId: 'other' }, watermark,
      { cursor: first.nextCursor! }), /codex_cursor_stale/u)
  } finally { database.close() }
})

test('a view or unknown native index schema cannot be treated as the native threads table', () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('CREATE VIEW threads AS SELECT 1 AS id')
    assert.throws(() => readCodexIndexPage(database, home, watermark), /codex_index_schema_unsupported/u)
  } finally { database.close() }
})

test('all three native inventory parts are required; overlays retain resource references and tombstones', () => {
  const catalog = new CodexRetainedCatalog(home, watermark)
  append(catalog, 'state-index', [candidate('native:empty'), candidate('native:archived', 'archived'), candidate('native:deleted', 'deleted')])
  assert.throws(() => catalog.seal(), /codex_inventory_incomplete/u)
  append(catalog, 'sessions', [{ ...candidate('native:archived'), historyReferences: ['resource:overlay'] }, candidate('native:old')])
  append(catalog, 'archived-sessions', [candidate('native:archived', 'archived')])
  catalog.seal()
  const result = catalog.page()
  assert.equal(result.rows.length, 4)
  const archived = result.rows.find(row => row.identity.nativeId === 'native:archived')!
  assert.equal(archived.state, 'archived')
  assert.deepEqual(archived.historyReferences, ['resource:native:archived', 'resource:overlay'])
  assert.equal(result.rows.find(row => row.identity.nativeId === 'native:deleted')?.state, 'deleted')
  const cursor = catalog.page({ limit: 1 }).nextCursor!
  const other = new CodexRetainedCatalog({ ...home, executorId: 'other' }, watermark)
  append(other, 'state-index'); append(other, 'sessions'); append(other, 'archived-sessions'); other.seal()
  assert.throws(() => other.page({ cursor }), /codex_catalog_cursor_stale/u)
})

test('interrupted or cyclic discovery cannot publish completeness or resurrect a tombstone', () => {
  const catalog = new CodexRetainedCatalog(home, watermark)
  catalog.append('state-index', { watermark, cursor: null, nextCursor: 'next', rows: [candidate('dead', 'deleted')] })
  assert.throws(() => catalog.page(), /codex_inventory_incomplete/u)
  assert.throws(() => catalog.append('state-index', { watermark, cursor: 'next', nextCursor: 'next', rows: [] }),
    /codex_inventory_cursor_not_advancing/u)
  assert.throws(() => append(catalog, 'sessions', [candidate('dead')]), /codex_tombstone_revival/u)
  assert.throws(() => append(catalog, 'sessions', [{ ...candidate('wrong'),
    identity: codexIdentity({ ...home, historyHomeKey: 'another' }, 'wrong') }]), /codex_inventory_source_mismatch/u)
})

test('native identity preserves opaque IDs and each admitted T3 app association, including deleted owners', () => {
  const identity = codexIdentity(home, 'opaque:/雪:original')
  assert.notEqual(codexIdentityKey(identity), codexIdentityKey(codexIdentity({ ...home, executorId: 'b' }, identity.nativeId)))
  const alias = { ...home, driver: 'codex', nativeId: identity.nativeId, environmentId: 'env:/雪',
    threadId: 'mcp:thread/a', providerThreadId: 'provider:1', sourceState: 'active' as const,
    strength: 'strong' as const, homeProofReference: 'proof:held' }
  const result = codexAssociationCandidates(identity, [alias, { ...alias, threadId: 'second', sourceState: 'deleted' },
    { ...alias, historyHomeKey: 'other' }])
  assert.equal(result.state, 'ambiguous')
  assert.equal(result.candidates.length, 2)
  assert.equal(result.control, 'unavailable')
  assert.equal(codexAssociationCandidates(identity, [{ ...alias, strength: 'weak' }]).state, 'unproven')
})
