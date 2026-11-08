import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { Sqlite, createSessionStateLayers, createSessionReadLayers, LegacyImporter,
  SourceContracts as S } from '@nessie/t3-session-source/engine'
import { T3CaptureJournal } from '../../dist/t3-session/state/journal.js'

const host = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
export const sqlLayer = path => Sqlite.layerFromPath(path).pipe(Layer.provide(host))
export const runSql = (path, program) => Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(sqlLayer(path)))))
export const syntheticOwner = { withReadScope: async (_input, use) => use({
  recheckSource: async () => {}, recheckThread: async () => {},
}) }

export async function engineFixture({ threads = 3, messages = 360 } = {}) {
  const directory = resolve('.artifacts/t04-engine', randomUUID())
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'synthetic-source.sqlite')
  const ids = Array.from({ length: threads }, (_, index) => `app:${String(index).padStart(5, '0')}`)
  ids.push('opaque:mcp/雪:𐀀', 'opaque:mcp/雪:')
  await runSql(path, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project:missing', 'Synthetic missing workspace', '/never/executed', '[]',
      '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`
    for (const [index, id] of ids.entries()) {
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at, archived_at, deleted_at, settled_override, settled_at)
        VALUES (${id}, 'project:missing', 'Same title', '{"instanceId":"disabled-unbound","model":"missing"}',
        'approval-required', 'default', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z',
        ${index === 1 ? '2020-01-02T00:00:00.000Z' : null}, ${index === 2 ? '2020-01-03T00:00:00.000Z' : null},
        'settled', '2020-01-02T00:00:00.000Z')`
    }
    for (let index = 0; index < messages; index++) {
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`message:${index}`}, ${ids[0]}, ${index % 2 ? 'assistant' : 'user'}, ${`ordinary transcript ${index} 雪`},
        0, ${new Date(Date.UTC(2020, 0, 1, 0, index)).toISOString()}, ${new Date(Date.UTC(2020, 0, 1, 0, index)).toISOString()})`
    }
  }))
  // Actual original importer establishes v2 plus a completed source hydration
  // marker. The capture must invalidate it when later legacy messages arrive.
  const state = createSessionStateLayers()
  const reads = createSessionReadLayers(state)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter
    yield* importer.reconcileShells
    yield* importer.ensureTranscript(S.ThreadId.make(ids[0]))
  }).pipe(Effect.provide(reads.layer.pipe(Layer.provideMerge(sqlLayer(path)))))))
  const writer = new DatabaseSync(path)
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
  writer.exec("CREATE TABLE synthetic_excluded_credentials (value TEXT); INSERT INTO synthetic_excluded_credentials VALUES ('never-read')")
  const physical = statSync(realpathSync(path))
  const source = { admittedRootKey: 'fixture:admitted', physicalRootKey: `fixture:${physical.dev}:${physical.ino}`,
    environmentId: S.EnvironmentId.make('fixture:environment'), layout: 'v2-80', databaseRole: 'authoritative-v2' }
  const sourcePort = { withReadonlySource: async (_manifest, key, use) => {
    assert.equal(key, source.admittedRootKey)
    const database = new DatabaseSync(path, { readOnly: true })
    const recheck = async () => {
      const current = statSync(realpathSync(path))
      assert.equal(current.dev, physical.dev); assert.equal(current.ino, physical.ino)
    }
    try { return await use(source, database, recheck) } finally { database.close() }
  } }
  const workspace = {
    createGeneration: async generation => ({ reference: generation, sql: sqlLayer(join(directory, `${generation}.sqlite`)) }),
    reopenGeneration: async reference => ({ reference, sql: sqlLayer(join(directory, `${reference}.sqlite`)) }),
  }
  const journalDatabase = new DatabaseSync(join(directory, 'local-capture-journal.sqlite'))
  const journal = new T3CaptureJournal(journalDatabase)
  const ports = { source: sourcePort, originalOwner: syntheticOwner, workspace, journal }
  const manifest = { revision: 'fixture:manifest', homes: [{ admittedRootKey: source.admittedRootKey, kind: 'configured-home' }] }
  return { directory, path, source, ids, ports, manifest, writer,
    destination: generation => join(directory, `${generation}.sqlite`),
    close: () => { journalDatabase.close(); writer.close() } }
}
