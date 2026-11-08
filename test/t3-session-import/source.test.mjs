import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { prepareTinySources } from './tiny-source.mjs'

const tiny = await prepareTinySources()
const { T3CaptureJournal } = await tiny.load('state/journal')
const { withT3SourceSnapshot } = await tiny.load('import/snapshot')
const { tablesForLayout } = await tiny.load('import/layout')
const { describeAliasCandidates } = await tiny.load('ownership/continuity')
const migrations = JSON.parse(readFileSync(join(tiny.directory, 'import/migration-manifest.json'), 'utf8'))
const source = { admittedRootKey: 'fixture:admission', physicalRootKey: 'fixture:inode', environmentId: 'env:雪',
  layout: 'v2-80', databaseRole: 'authoritative-v2' }
const manifest = { revision: 'fixture:manifest', homes: [{ admittedRootKey: source.admittedRootKey, kind: 'configured-home' }] }
const owner = { withReadScope: async (_input, use) => use({ recheckSource: async () => {}, recheckThread: async () => {} }) }
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')

function fixture(name) {
  const path = join(tiny.directory, `${name}.sqlite`)
  const writer = new DatabaseSync(path)
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
  writer.exec('CREATE TABLE effect_sql_migrations (migration_id INTEGER, name TEXT)')
  const insert = writer.prepare('INSERT INTO effect_sql_migrations VALUES (?, ?)')
  for (const row of migrations) insert.run(...row)
  // Synthetic schema tests only. Actual original migrations/importer run in engine.test.mjs.
  for (const entry of tablesForLayout('v2-80')) {
    writer.exec(`CREATE TABLE ${entry.name} (${entry.columns.map(column => `${column} ${[
      'sequence', 'schema_version', 'last_sequence', 'application_event_version', 'stream_version', 'ordinal',
    ].includes(column) ? 'INTEGER' : 'TEXT'}`).join(', ')})`)
  }
  writer.exec(`CREATE TABLE auth_credentials (value TEXT); INSERT INTO auth_credentials VALUES ('excluded-sentinel');
    CREATE TABLE server_secret_store (value TEXT); INSERT INTO server_secret_store VALUES ('vault-sentinel');
    CREATE TABLE orchestration_v2_effect_outbox (payload_json TEXT);
    INSERT INTO orchestration_v2_effect_outbox VALUES ('effect-sentinel')`)
  const statements = []
  let recheck = async () => {}
  const port = { withReadonlySource: async (_manifest, key, use) => {
    assert.equal(key, source.admittedRootKey)
    const db = new DatabaseSync(path, { readOnly: true })
    // Actual supported readonly open, not a claimed flag on a writable mock.
    assert.throws(() => db.exec("INSERT INTO auth_credentials VALUES ('refused')"), /readonly/iu)
    const observed = { exec: sql => { statements.push(sql); return db.exec(sql) },
      prepare: sql => { statements.push(sql); return db.prepare(sql) } }
    try { return await use(source, observed, () => recheck()) } finally { db.close() }
  } }
  return { path, writer, port, statements, setRecheck: value => { recheck = value } }
}
const capture = (f, use, after, readOwner = owner) =>
  withT3SourceSnapshot(f.port, manifest, source.admittedRootKey, readOwner, 'capture:fixture', use, after)

test('one supported WAL snapshot, next generation sees additions, no source persistent writes or excluded reads', async () => {
  const f = fixture('wal')
  try {
    const before = { main: hash(f.path), wal: hash(`${f.path}-wal`), schema: f.writer.prepare('PRAGMA schema_version').get() }
    await capture(f, async snapshot => {
      const table = snapshot.tables.find(entry => entry.name === 'orchestration_v2_projection_threads')
      assert.throws(() => { table.name = 'auth_credentials' }, TypeError)
      assert.throws(() => { table.columns.push('credential') }, TypeError)
      assert.equal([...snapshot.rows(table)].length, 0)
      f.writer.exec(`INSERT INTO orchestration_v2_projection_threads (thread_id, payload_json) VALUES ('later:雪', '{}')`)
      assert.equal([...snapshot.rows(table)].length, 0)
    })
    const afterWrite = { main: hash(f.path), wal: hash(`${f.path}-wal`), schema: f.writer.prepare('PRAGMA schema_version').get() }
    assert.equal(before.main, afterWrite.main)
    assert.notEqual(before.wal, afterWrite.wal)
    assert.deepEqual(before.schema, afterWrite.schema)
    await capture(f, async snapshot => {
      for (const table of snapshot.tables) [...snapshot.rows(table)]
      const table = snapshot.tables.find(entry => entry.name === 'orchestration_v2_projection_threads')
      assert.equal([...snapshot.rows(table)].length, 1)
      assert.throws(() => [...snapshot.rows({ name: 'auth_credentials' })], /table_not_admitted/u)
    })
    assert.equal(hash(f.path), afterWrite.main)
    assert.equal(hash(`${f.path}-wal`), afterWrite.wal)
    assert.deepEqual(f.writer.prepare('PRAGMA schema_version').get(), before.schema)
    assert.equal(f.statements.some(sql => /auth_credentials|server_secret_store|effect_outbox/iu.test(sql)), false)
    assert.equal(f.statements.some(sql => /\bPRAGMA\s+(?:wal_checkpoint|journal_mode)\b|immutable=/iu.test(sql) ||
      /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/iu.test(sql)), false)
  } finally { f.writer.close() }
})

test('unsupported layout, corrupt/unreadable/half capture and physical replacement are truthful', async () => {
  const f = fixture('unavailable')
  try {
    f.writer.exec('UPDATE effect_sql_migrations SET name = \'divergent\' WHERE migration_id = 80')
    await assert.rejects(capture(f, async () => {}), /unsupported_source_migration/u)
    f.writer.prepare('UPDATE effect_sql_migrations SET name = ? WHERE migration_id = 80').run(migrations[79][1])
    f.setRecheck(async () => { throw new Error('physical replacement') })
    await assert.rejects(capture(f, async () => {}), /unavailable_or_invalid/u)
    f.setRecheck(async () => {})
    await assert.rejects(capture(f, async () => { throw new Error('interrupted halfway') }), /unavailable_or_invalid/u)
    let changed = false
    f.setRecheck(async () => { if (changed) throw new Error('rebound') })
    await assert.rejects(capture(f, async () => { changed = true }), /unavailable_or_invalid/u)
    const db = new DatabaseSync(join(tiny.directory, 'missing-schema.sqlite'))
    const port = { withReadonlySource: async (_m, _k, use) => use(source, db, async () => {}) }
    try {
      await assert.rejects(withT3SourceSnapshot(port, manifest, source.admittedRootKey, owner, 'x', async () => {}),
        /unsupported_source_migration/u)
    } finally { db.close() }
    for (const kind of ['corrupt', 'inaccessible']) {
      const path = join(tiny.directory, `${kind}.sqlite`)
      if (kind === 'corrupt') writeFileSync(path, 'synthetic corrupt SQLite bytes')
      const unavailablePort = { withReadonlySource: async (_m, _k, use) => {
        const database = new DatabaseSync(path, { readOnly: true })
        try { return await use(source, database, async () => {}) } finally { database.close() }
      } }
      await assert.rejects(withT3SourceSnapshot(unavailablePort, manifest, source.admittedRootKey,
        owner, 'capture:invalid', async () => { assert.fail('Invalid source cannot become empty success') }))
    }
  } finally { f.writer.close() }
})

test('both real producer ports are mandatory; serialized metadata cannot mint a lease', async () => {
  await assert.rejects(withT3SourceSnapshot(undefined, manifest, source.admittedRootKey, owner, 'x', async () => {}),
    /required_admitted_local_source_port/u)
  const f = fixture('admission')
  try {
    for (const unbound of [null, { admissionReference: 'copied', expiresAt: '2099-01-01' }, JSON.parse(JSON.stringify(owner))]) {
      await assert.rejects(capture(f, async () => {}, undefined, unbound), /required_original_owner_continuity_port/u)
    }
    let revoked = false
    let now = 0
    const scoped = { withReadScope: async (input, use) => {
      assert.equal(input.source.physicalRootKey, source.physicalRootKey)
      assert.equal(input.source.environmentId, source.environmentId)
      assert.equal(input.captureGeneration, 'capture:fixture')
      assert.equal(input.purpose, 'retained-history-read')
      assert.equal(typeof input.physicalSourceRecheck, 'function')
      let active = true
      const recheckSource = async () => { assert.equal(active && !revoked && now <= 60_000, true, 'lease unavailable') }
      try { return await use({ recheckSource, recheckThread: async id => {
        await recheckSource(); assert.equal(id, 'owned:thread', 'cross-thread refused')
      } }) } finally { active = false }
    } }
    await assert.rejects(capture(f, async (_s, lease) => { await lease.recheckThread('foreign:thread') }, undefined, scoped),
      /unavailable_or_invalid/u)
    await assert.rejects(capture(f, async () => { revoked = true }, undefined, scoped), /unavailable_or_invalid/u)
    revoked = false
    await assert.rejects(capture(f, async () => { now = 60_001 }, undefined, scoped), /unavailable_or_invalid/u)
    now = 0
    let saved
    await capture(f, async (_s, lease) => { saved = lease }, undefined, scoped)
    await assert.rejects(saved.recheckSource(), /lease unavailable/u)
    await assert.rejects(withT3SourceSnapshot(f.port, manifest, source.admittedRootKey, scoped,
      'other:generation', async () => {}))
    const crossed = { withReadonlySource: async (m, k, use) => f.port.withReadonlySource(m, k,
      (current, database, recheck) => use({ ...current, physicalRootKey: 'foreign:physical' }, database, recheck)) }
    await assert.rejects(withT3SourceSnapshot(crossed, manifest, source.admittedRootKey, scoped,
      'capture:fixture', async () => {}))
    const foreignEnvironment = { withReadonlySource: async (m, k, use) => f.port.withReadonlySource(m, k,
      (current, database, recheck) => use({ ...current, environmentId: 'foreign:environment' }, database, recheck)) }
    await assert.rejects(withT3SourceSnapshot(foreignEnvironment, manifest, source.admittedRootKey, scoped,
      'capture:fixture', async () => {}))
  } finally { f.writer.close() }
})

test('durable aliases converge, divergent roots conflict stickily, refresh fences completion and retains tombstones', () => {
  const db = new DatabaseSync(join(tiny.directory, 'journal.sqlite'))
  const other = new DatabaseSync(join(tiny.directory, 'journal.sqlite'))
  try {
    const journal = new T3CaptureJournal(db)
    const concurrent = new T3CaptureJournal(other)
    journal.begin(source, 'g1', 'stage:g1')
    journal.markCaptured(source, 'g1', 3)
    journal.complete(source, 'g1', [{ threadId: 'old', state: 'active' }, { threadId: 'gone', state: 'deleted' }], [])
    journal.begin({ ...source, admittedRootKey: 'proven:symlink' }, 'g2', 'stage:g2')
    assert.equal(journal.root(source.physicalRootKey).catalog_generation, null)
    journal.markCaptured(source, 'g2', 4)
    concurrent.begin(source, 'g3', 'stage:g3')
    assert.throws(() => journal.complete(source, 'g2', [], []), /obsolete/u)
    journal.markCaptured(source, 'g3', 5)
    journal.fail(source, 'g3', 'synthetic-interruption')
    assert.equal(journal.catalog(source.physicalRootKey).length, 2)
    journal.recover(source, 'g3')
    journal.complete(source, 'g3', [{ threadId: 'gone', state: 'active' }], [])
    assert.equal(journal.catalog(source.physicalRootKey).find(row => row.thread_id === 'gone').source_state, 'deleted')
    assert.throws(() => journal.begin({ ...source, admittedRootKey: 'clone', physicalRootKey: 'different-physical-root' },
      'g4', 'stage:g4'), /divergent_physical_source_roots/u)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t3_capture_roots').get().n, 2)
    journal.unavailable('clone')
    assert.throws(() => journal.begin(source, 'g5', 'stage:g5'), /divergent/u)
    assert.equal(journal.catalog(source.physicalRootKey).length, 2)
    assert.throws(() => journal.begin({ ...source, physicalRootKey: 'rebound' }, 'g6', 'stage:g6'), /alias_rebinding/u)
  } finally { other.close(); db.close() }
})

test('native aliases retain each app history, home distinctions, weak refs and ambiguity without takeover', () => {
  const first = { threadId: 'app:1', providerThreadId: 'p1', driver: 'codex', nativeId: 'native', strength: 'strong',
    continuationHomeKey: 'home', historyHomeKey: 'overlay1', homeProofReference: 'fixture-proof' }
  assert.equal(describeAliasCandidates([first, { ...first, threadId: 'app:2', historyHomeKey: 'overlay2' }]).state, 'ambiguous')
  assert.equal(describeAliasCandidates([{ ...first, strength: 'weak' }]).state, 'unproven')
  assert.equal(describeAliasCandidates([first]).control, 'unavailable')
  assert.equal(describeAliasCandidates([]).state, 'missing')
})

test('migration manifest matches exact committed upstream objects without replacements', () => {
  const reference = process.env.T3_SESSION_IMPORT_REFERENCE
  assert.ok(reference, 'Set the explicit readonly committed-object reference repository.')
  const revision = '25bf84ab07f53f141c20239c63e383823a9d5ea0'
  const git = args => execFileSync('git', ['--no-replace-objects', '-C', reference, ...args], { encoding: 'utf8' })
  assert.equal(git(['rev-parse', `${revision}^{tree}`]).trim(), 'b0ba4dad62fa11e0a1fd21f5d351d75926d7559e')
  const original = git(['show', `${revision}:apps/server/src/persistence/Migrations.ts`])
  assert.deepEqual([...original.matchAll(/\[(\d+), "([^"]+)", Migration\d+\]/gu)].map(row => [Number(row[1]), row[2]]), migrations)
  assert.equal(tablesForLayout('v2-80').some(row => /outbox|auth|secret|webhook|schedule|recovery|launch_workflow/u.test(row.name)), false)
})
