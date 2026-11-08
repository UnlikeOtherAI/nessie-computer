// Explicit installed Windows lane only. No skips and no substitute helper,
// fixture admission boolean or path-based source implementation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rename, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { ensureOwnerOnlyStateDirectory, secureOwnerOnlyStateFile } from '../../dist/state-security.js'
import { registerMachineT3Sources, machineT3Sources } from '../../dist/t3-session/source/owner.js'
import { tablesForLayout, selectCaptureRows, legacyMessages } from '../../dist/t3-session/import/layout.js'

assert.equal(process.platform, 'win32', 'run this gate only in its assigned Windows qualification lane')
assert.equal(process.env.NESSIE_EXECUTOR_PACKAGED_CLI, '1', 'use the actual packaged candidate Node/helper')
const migrations = JSON.parse(await readFile(new URL('../../src/t3-session/import/migration-manifest.json', import.meta.url)))

async function fixture(layout = 'legacy-54') {
  const temporary = await mkdtemp(join(tmpdir(), 'nessie-source-'))
  await ensureOwnerOnlyStateDirectory(temporary)
  const root = join(temporary, 'userdata')
  const state = join(temporary, 'executor')
  await ensureOwnerOnlyStateDirectory(root)
  await ensureOwnerOnlyStateDirectory(state)
  const path = join(root, layout === 'v2-80' ? 'statev2.sqlite' : 'state.sqlite')
  const writer = new DatabaseSync(path)
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE effect_sql_migrations(migration_id INTEGER,name TEXT)')
  for (const row of migrations.slice(0, layout === 'v2-80' ? 80 : 54)) {
    writer.prepare('INSERT INTO effect_sql_migrations VALUES (?, ?)').run(...row)
  }
  for (const entry of tablesForLayout(layout)) {
    writer.exec(`CREATE TABLE ${entry.name} (${entry.columns.map(name => `${name} ${name === 'sequence' ? 'INTEGER' : 'TEXT'}`).join(',')})`)
  }
  await writeFile(join(root, 'environment-id'), 'env:雪\n')
  const configuration = { executorId: `fixture-${temporary}`, apiBaseUrl: 'https://example.invalid',
    machinePrivateKey: 'synthetic-unused', machinePublicKey: 'synthetic-unused',
    workspaceFolders: [{ name: 'workspace', path: temporary }],
    descriptor: { revision: 1, limits: { maxCommandRuntimeSeconds: 60, maxResultBytes: 1024, maxSessions: 1 },
      operationKeys: [], profiles: [] },
    t3SourceHomes: [{ admittedRootKey: 'one', kind: 'configured-home', stateDirectory: root }] }
  const configPath = join(state, 'executor-state.json')
  await writeFile(configPath, JSON.stringify(configuration))
  for (const item of [path, `${path}-wal`, `${path}-shm`, configPath, join(root, 'environment-id')]) {
    await secureOwnerOnlyStateFile(item)
  }
  const release = registerMachineT3Sources(state, configuration.executorId)
  const owner = machineT3Sources(configuration.executorId)
  return { temporary, root, state, writer, owner, configuration, configPath, path,
    close: async () => { release(); writer.close(); await rm(temporary, { recursive: true, force: true }) } }
}

test('registered producer opens real WAL reader, recognizes only its issued live callback and keeps original chronology', async () => {
  const f = await fixture()
  try {
    f.writer.exec(`INSERT INTO projection_thread_messages(message_id,thread_id,created_at,text)
      VALUES ('late','thread:雪','2001-01-02','two'),('early','thread:雪','2001-01-01','one')`)
    const manifest = await f.owner.manifest()
    let saved
    await assert.rejects(f.owner.recognize(async () => {}), /not_issued_here/u)
    await f.owner.withReadonlySource(manifest, 'one', async (source, db, recheck) => {
      saved = recheck
      const binding = await f.owner.recognize(recheck)
      assert.equal(binding.source, source)
      assert.equal(binding.legacyCopyProvenance, 'not_attested_by_original_source')
      db.exec('BEGIN')
      assert.deepEqual(db.prepare(selectCaptureRows(legacyMessages)).all().map(row => row.message_id), ['early', 'late'])
      f.writer.exec(`INSERT INTO projection_thread_messages(message_id,thread_id,created_at) VALUES ('new','thread:雪','2001-01-03')`)
      assert.deepEqual(db.prepare(selectCaptureRows(legacyMessages)).all().map(row => row.message_id), ['early', 'late'])
      db.exec('COMMIT')
      await recheck()
      await assert.rejects(rename(f.path, `${f.path}.replaced`))
    })
    await assert.rejects(saved(), /closed/u)
    await assert.rejects(f.owner.recognize(saved), /not_issued_here/u)
    await f.owner.withReadonlySource(manifest, 'one', async (_source, db) => {
      assert.deepEqual(db.prepare(selectCaptureRows(legacyMessages)).all().map(row => row.message_id), ['early', 'late', 'new'])
    })
  } finally { await f.close() }
})

test('configuration revocation after await and at final return refuses the callback result', async () => {
  for (const recheckBeforeReturn of [true, false]) {
    const f = await fixture()
    try {
      await assert.rejects(f.owner.withReadonlySource(await f.owner.manifest(), 'one', async (_source, _db, recheck) => {
        await Promise.resolve()
        const replacement = `${f.configPath}.new`
        await writeFile(replacement, JSON.stringify({ ...f.configuration, t3SourceHomes: [] }))
        await secureOwnerOnlyStateFile(replacement)
        await rename(replacement, f.configPath)
        if (recheckBeforeReturn) await recheck()
        return 'must not escape'
      }), /changed_or_unavailable/u)
    } finally { await f.close() }
  }
})

test('entire manifest is required; missing roots remain entries; simultaneous aliases share physical identity', async () => {
  const f = await fixture()
  try {
    f.configuration.t3SourceHomes.push({ admittedRootKey: 'alias', kind: 'configured-home', stateDirectory: f.root },
      { admittedRootKey: 'missing', kind: 'configured-home', stateDirectory: join(f.temporary, 'missing', 'userdata') })
    await writeFile(f.configPath, JSON.stringify(f.configuration))
    const manifest = await f.owner.manifest()
    assert.equal(manifest.homes.length, 3)
    await assert.rejects(f.owner.withReadonlySource({ ...manifest, homes: manifest.homes.slice(0, 1) }, 'one', async () => {}), /incomplete/u)
    await f.owner.withReadonlySource(manifest, 'one', async first => {
      await f.owner.withReadonlySource(manifest, 'alias', async second => {
        assert.equal(first.physicalRootKey, second.physicalRootKey)
      })
    })
    await assert.rejects(f.owner.withReadonlySource(manifest, 'missing', async () => assert.fail('unavailable root admitted')))
  } finally { await f.close() }
})

test('unsupported migrations, missing tables and corrupt authoritative v2 refuse before callback', async () => {
  for (const corruption of ['migration', 'table', 'v2']) {
    const f = await fixture()
    try {
      if (corruption === 'migration') f.writer.exec('DELETE FROM effect_sql_migrations WHERE migration_id = 54')
      if (corruption === 'table') f.writer.exec('DROP TABLE projection_thread_messages')
      if (corruption === 'v2') await writeFile(join(f.root, 'statev2.sqlite'), 'corrupt')
      await assert.rejects(f.owner.withReadonlySource(await f.owner.manifest(), 'one', async () => assert.fail('bad source admitted')))
    } finally { await f.close() }
  }
})
