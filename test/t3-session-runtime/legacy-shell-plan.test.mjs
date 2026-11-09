import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import { LegacyImporter, EventSink, SessionLifecycleActionRefused, withSessionLegacyShellReconciliation,
  OriginalSqliteClient } from '@nessie/t3-session-source/engine'
import { T3ExecutionLegacyShellObservationSchema } from '@nessie/executor-protocol'
import { withOriginalState } from './outbox-fixture.mjs'

// Synthetic data and owners through actual original SQL/events. No native or
// backend lifecycle permission, provider execution or installed readiness.
const withLegacy = program => withOriginalState(Effect.gen(function* () {
  const context = yield* Layer.build(LegacyImporter.layer)
  return yield* program.pipe(Effect.provide(context))
}))
const seed = (id, project = 'legacy:project') => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${project}, 'Synthetic legacy project', 'C:/synthetic/never-executed', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z') ON CONFLICT DO NOTHING`
  yield* sql`INSERT INTO projection_threads
    (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${id}, ${project}, 'PRIVATE_SHELL_TITLE', '{"instanceId":"codex","model":"synthetic"}',
      'approval-required', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  for (const [index, role] of [[0, 'user'], [1, 'assistant']]) yield* sql`INSERT INTO projection_thread_messages
    (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
    VALUES (${`${id}:message:${index}`}, ${id}, ${role}, 'PRIVATE_SHELL_PREVIEW', 0,
      ${`2026-01-01T00:00:0${index}.000Z`}, ${`2026-01-01T00:00:0${index}.000Z`})`
})
const state = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const result = {}
  for (const table of ['projection_threads', 'projection_thread_messages', 'orchestration_events',
    'orchestration_v2_projection_threads', 'orchestration_v2_projection_messages',
    'orchestration_v2_legacy_imports', 'orchestration_v2_turn_item_positions']) {
    result[table] = (yield* sql.unsafe(`SELECT * FROM ${table} ORDER BY rowid`)).map(row => ({ ...row }))
  }
  return result
})
const window = (candidate, milliseconds = 3000) => {
  const remaining = Math.min(candidate.observedAtMs + 4500 - Date.now(), milliseconds)
  return { notAfterMs: Date.now() + remaining, notAfterMonotonicMs: performance.now() + remaining }
}
const refused = work => work.pipe(Effect.result, Effect.map(result => {
  assert.equal(result._tag, 'Failure')
  return result.failure
}))

test('whole legacy-shell plan is readonly, private, complete and uses the actual original writer once', async () => {
  await withLegacy(Effect.gen(function* () {
    yield* seed('legacy:first').pipe(Effect.andThen(seed('legacy:second')))
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter
    const before = yield* state
    const plan = yield* importer.prepareShellReconciliation
    assert.deepEqual(yield* state, before)
    assert.deepEqual(plan.targets, ['legacy:first', 'legacy:second'].map(threadId => ({
      action: 'import', threadId, projectId: 'legacy:project' })))
    assert.match(plan.planDigest, /^sha256:[a-f0-9]{64}$/u)
    assert.equal(JSON.stringify(plan).includes('PRIVATE_'), false)
    const actual = yield* importer.reconcileShellsPrepared({ candidate: plan, ...window(plan) })
    assert.deepEqual(actual, { importedThreadCount: 2, importedMessageCount: 4 })
    const written = yield* state
    assert.equal(written.orchestration_v2_projection_threads.length, 2)
    assert.equal(written.orchestration_v2_projection_messages.length, 4)
    assert.equal(written.orchestration_v2_turn_item_positions.length, 4)
    yield* refused(importer.reconcileShellsPrepared({ candidate: plan,
      notAfterMs: Date.now() + 1000, notAfterMonotonicMs: performance.now() + 1000 }))
    assert.throws(() => plan.planDigest)
    assert.deepEqual(yield* importer.reconcileShells, { importedThreadCount: 0, importedMessageCount: 0 })
    const empty = yield* importer.prepareShellReconciliation
    assert.deepEqual(empty.targets, [])
    assert.deepEqual(yield* importer.reconcileShellsPrepared({ candidate: empty, ...window(empty) }),
      { importedThreadCount: 0, importedMessageCount: 0 })
  }))
})

test('lifecycle owner receives the original complete shell plan and preserves its actual result', async () => {
  await withLegacy(Effect.gen(function* () {
    yield* seed('legacy:owned')
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter
    let observed
    const result = yield* withSessionLegacyShellReconciliation({
      withLegacyShellReconciliation: (candidate, write) => {
        observed = candidate
        assert.deepEqual(candidate.targets.map(target => target.threadId), ['legacy:owned'])
        return write(window(candidate))
      },
    }, importer)
    assert.deepEqual(result, { importedThreadCount: 1, importedMessageCount: 2 })
    assert.throws(() => observed.targets)
  }))
})

test('prepared legacy metadata repair shares the original codec and targets its actual stored thread', async () => {
  await withLegacy(Effect.gen(function* () {
    yield* seed('legacy:repair')
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter, sql = yield* SqlClient.SqlClient
    yield* importer.reconcileShells
    yield* sql`UPDATE projection_threads SET pinned_at = '2026-01-02T00:00:00.000Z' WHERE thread_id = 'legacy:repair'`
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_remove(payload_json, '$.pinnedAt')
      WHERE thread_id = 'legacy:repair'`
    const candidate = yield* importer.prepareShellReconciliation
    assert.deepEqual(candidate.targets, [{ action: 'repair', threadId: 'legacy:repair', projectId: 'legacy:project' }])
    assert.deepEqual(yield* importer.reconcileShellsPrepared({ candidate, ...window(candidate) }),
      { importedThreadCount: 1, importedMessageCount: 0 })
    const rows = yield* sql`SELECT json_extract(payload_json, '$.pinnedAt') AS pinned
      FROM orchestration_v2_projection_threads WHERE thread_id = 'legacy:repair'`
    assert.equal(rows[0].pinned, '2026-01-02T00:00:00.000Z')
  }))
})

test('denied or skipped legacy admission cannot write or retain an escaped original writer', async () => {
  for (const mode of ['denied', 'skipped']) await withLegacy(Effect.gen(function* () {
    yield* seed('legacy:denied')
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter
    const before = yield* state
    let escaped, cap, candidate
    yield* refused(withSessionLegacyShellReconciliation({ withLegacyShellReconciliation: (plan, write) => {
      candidate = plan; escaped = write; cap = window(plan)
      return mode === 'denied' ? Effect.fail(new SessionLifecycleActionRefused()) : Effect.succeed({})
    } }, importer))
    yield* refused(escaped(cap))
    yield* refused(importer.reconcileShellsPrepared({ candidate, ...cap }))
    assert.deepEqual(yield* state, before)
  }))
})

test('selected source, preview, membership and schema changes refuse the whole prepared shell action', async () => {
  for (const change of ['title', 'preview', 'membership', 'schema']) await withLegacy(Effect.gen(function* () {
    yield* seed('legacy:changing')
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter, sql = yield* SqlClient.SqlClient
    const candidate = yield* importer.prepareShellReconciliation, cap = window(candidate)
    if (change === 'title') yield* sql`UPDATE projection_threads SET title = 'changed' WHERE thread_id = 'legacy:changing'`
    if (change === 'preview') yield* sql`UPDATE projection_thread_messages SET text = 'changed'`
    if (change === 'membership') yield* seed('legacy:added')
    if (change === 'schema') yield* sql`CREATE INDEX synthetic_changed_shell ON projection_threads(title)`
    const before = yield* state
    yield* refused(importer.reconcileShellsPrepared({ candidate, ...cap }))
    assert.deepEqual(yield* state, before)
  }))
})

test('a conflicting original event slot cannot change target ownership after shell planning', async () => {
  for (const other of ['unrelated-thread', 'legacy:other-selected']) await withLegacy(Effect.gen(function* () {
    yield* seed('legacy:slots')
    if (other === 'legacy:other-selected') yield* seed(other)
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter, sql = yield* SqlClient.SqlClient
    const candidate = yield* importer.prepareShellReconciliation, cap = window(candidate)
    yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      VALUES ('migration:v1:message:legacy:slots:message:0', 'thread', ${other}, 1, 'message.updated',
        '2026-01-01T00:00:00.000Z', 'system', '{}', '{}', 2)`
    const before = yield* state
    yield* refused(importer.reconcileShellsPrepared({ candidate, ...cap }))
    assert.deepEqual(yield* state, before)
    yield* refused(importer.prepareShellReconciliation)
  }))
})

test('legacy plans refuse ambient transactions, unissued candidates and scope escape without changing state', async () => {
  await withLegacy(Effect.gen(function* () {
    yield* seed('legacy:scope')
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter, sql = yield* SqlClient.SqlClient
    const before = yield* state
    yield* refused(sql.withTransaction(importer.prepareShellReconciliation))
    const closed = yield* Effect.scoped(importer.prepareShellReconciliation)
    yield* refused(importer.reconcileShellsPrepared({ candidate: closed,
      notAfterMs: Date.now() + 1000, notAfterMonotonicMs: performance.now() + 1000 }))
    const candidate = yield* importer.prepareShellReconciliation, cap = window(candidate)
    yield* refused(importer.reconcileShellsPrepared({ candidate: { ...candidate }, ...cap }))
    yield* refused(sql.withTransaction(importer.reconcileShellsPrepared({ candidate, ...cap })))
    yield* refused(importer.reconcileShellsPrepared({ candidate, ...cap }))
    assert.deepEqual(yield* state, before)
  }))
})

test('expired and overlong shell windows consume the attempt without changing physical state', async () => {
  for (const mode of ['expired', 'overlong']) await withLegacy(Effect.gen(function* () {
    yield* seed('legacy:expiry')
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter
    const before = yield* state, candidate = yield* importer.prepareShellReconciliation
    const cap = mode === 'expired' ? window(candidate, -1)
      : { notAfterMs: candidate.observedAtMs + 10000, notAfterMonotonicMs: performance.now() + 10000 }
    yield* refused(importer.reconcileShellsPrepared({ candidate, ...cap }))
    yield* refused(importer.reconcileShellsPrepared({ candidate, ...window({ observedAtMs: Date.now() }) }))
    assert.deepEqual(yield* state, before)
  }))
})

test('actual shell write failure rolls back earlier imports and all original publication state', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seed('legacy:first').pipe(Effect.andThen(seed('legacy:second')))
    const original = yield* EventSink.EventSinkV2
    let writes = 0
    const failing = { ...original, write: input => ++writes === 2
      ? Effect.fail(new EventSink.EventSinkWriteError({ eventCount: input.events.length })) : original.write(input) }
    const context = yield* Layer.build(LegacyImporter.layer.pipe(
      Layer.provide(Layer.succeed(EventSink.EventSinkV2, failing))))
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter.pipe(Effect.provide(context))
    const before = yield* state, candidate = yield* importer.prepareShellReconciliation
    yield* refused(importer.reconcileShellsPrepared({ candidate, ...window(candidate) }))
    assert.equal(writes, 2)
    assert.deepEqual(yield* state, before)
  }))
})

test('unexpected persistent, forged search, TEMP triggers and incoming foreign keys refuse shell planning', async () => {
  for (const mode of ['persistent', 'search', 'temporary', 'foreign-key']) await withLegacy(Effect.gen(function* () {
    yield* seed('legacy:trigger')
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter, sql = yield* SqlClient.SqlClient
    if (mode === 'search') yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`
    const name = mode === 'search' ? 'orchestration_v2_message_search_insert' : 'synthetic_unplanned_trigger'
    if (mode === 'foreign-key') yield* sql`CREATE TABLE synthetic_foreign_shell
      (target TEXT REFERENCES orchestration_v2_projection_threads(thread_id) ON DELETE CASCADE)`
    else yield* sql.unsafe(`CREATE ${mode === 'temporary' ? 'TEMP ' : ''}TRIGGER ${name}
      AFTER INSERT ON orchestration_v2_projection_messages BEGIN SELECT 1; END`)
    const before = yield* state
    yield* refused(importer.prepareShellReconciliation)
    assert.deepEqual(yield* state, before)
  }))
})

test('finite SQLite windows cover cached steps and commit while permitting expired rollback cleanup', async () => {
  await withOriginalState(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE synthetic_window (value INTEGER)`
    const insert = value => sql`INSERT INTO synthetic_window VALUES (${value})`
    yield* insert(1) // Warm the same real prepared statement outside a finite action.
    const expired = { notAfterMs: Date.now() - 1, notAfterMonotonicMs: performance.now() - 1 }
    yield* refused(insert(2).pipe(OriginalSqliteClient.withStatementDeadline(expired)))
    const deadline = { notAfterMs: Date.now() + 100, notAfterMonotonicMs: performance.now() + 100 }
    yield* refused(sql.withTransaction(insert(3).pipe(Effect.andThen(Effect.sleep(150))))
      .pipe(OriginalSqliteClient.withStatementDeadline(deadline)))
    assert.deepEqual((yield* sql`SELECT value FROM synthetic_window`).map(row => row.value), [1])
    yield* insert(4)
    assert.deepEqual((yield* sql`SELECT value FROM synthetic_window ORDER BY value`).map(row => row.value), [1, 4])
  }))
})

test('the native fixture reproduces the complete original shell candidate through the real importer', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/legacy-shell-plan.json', import.meta.url), 'utf8'))
  await withLegacy(Effect.gen(function* () {
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter, sql = yield* SqlClient.SqlClient
    for (const statement of fixture.dataStatements) {
      yield* sql.unsafe(statement.replace(/^INSERT INTO/u, 'INSERT OR IGNORE INTO'))
    }
    const candidate = yield* importer.prepareShellReconciliation
    assert.equal(candidate.planDigest, fixture.planDigest)
    assert.deepEqual(candidate.targets, fixture.targets)
  }))
})

test('unsigned shell metadata accepts no raw plan, path, additional target field or unsupported action', () => {
  const raw = { version: 1, observedAtMs: Date.now(), planDigest: 'sha256:' + 'a'.repeat(64),
    targets: [{ action: 'import', threadId: 'observed:thread', projectId: 'observed:project' }] }
  assert.deepEqual(T3ExecutionLegacyShellObservationSchema.parse(raw), raw)
  for (const value of [{ ...raw, inputs: {} }, { ...raw, path: 'caller.sqlite' },
    { ...raw, targets: [{ ...raw.targets[0], grant: true }] },
    { ...raw, targets: [{ ...raw.targets[0], action: 'authorize' }] },
    { ...raw, targets: Array.from({ length: 257 }, () => raw.targets[0]) }]) {
    assert.equal(T3ExecutionLegacyShellObservationSchema.safeParse(value).success, false)
  }
})
