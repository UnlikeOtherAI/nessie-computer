import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { SourceContracts as S, RequestPrivacy, ThreadStream } from '@nessie/t3-session-source/engine'
import { captureRetainedT3, resumeRetainedT3 } from '../../dist/t3-session/import/capture.js'
import { readRetainedProjection, readRetainedHistoryPage, readRetainedSnapshotWindow } from '../../dist/t3-session/import/reads.js'
import { engineFixture, runSql } from './engine-fixture.mjs'

const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const capture = f => captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
const projection = (f, generation) => readRetainedProjection(f.ports, f.manifest, f.source.admittedRootKey,
  generation, S.ThreadId.make(f.ids[0]))

test('normal package/original importer retains complete old catalog, original opaque IDs and full history across refresh', async () => {
  const f = await engineFixture({ threads: 5_005 })
  try {
    const before = { main: digest(f.path), wal: digest(`${f.path}-wal`) }
    const first = await capture(f)
    assert.equal(first.localState, 'ready')
    assert.equal(first.serverCatalog, 'required_unbound')
    assert.equal(first.control, 'unavailable')
    assert.equal(first.nativeHomes, 'required_unbound')
    assert.equal(f.ports.journal.catalog(f.source.physicalRootKey).length, f.ids.length)
    assert.equal(f.ports.journal.catalog(f.source.physicalRootKey).find(row => row.thread_id === f.ids[1]).source_state, 'archived')
    assert.equal(f.ports.journal.catalog(f.source.physicalRootKey).find(row => row.thread_id === f.ids[2]).source_state, 'deleted')
    assert.equal((await projection(f, first.generation)).messages.length, 360)
    const sourceCatalog = f.writer.prepare(`SELECT thread_id,
      CASE WHEN deleted_at IS NOT NULL THEN 'deleted' WHEN archived_at IS NOT NULL THEN 'archived'
      ELSE 'active' END AS source_state FROM orchestration_v2_projection_threads ORDER BY thread_id`).all()
    assert.deepEqual(f.ports.journal.catalog(f.source.physicalRootKey)
      .map(({ thread_id, source_state }) => ({ thread_id, source_state })),
    sourceCatalog.map(row => ({ ...row })))
    const destination = new DatabaseSync(f.destination(first.generation), { readOnly: true })
    try {
      // Independent original stored records, including exact metadata and order,
      // rather than generated expected counts or a second capture projection.
      for (const [table, order] of [
        ['orchestration_v2_projection_threads', 'thread_id'],
        ['orchestration_v2_projection_messages', 'thread_id, created_at, message_id'],
        ['orchestration_v2_projection_turn_items', 'thread_id, ordinal, turn_item_id'],
      ]) {
        const sql = `SELECT payload_json FROM ${table} ORDER BY ${order}`
        assert.deepEqual(destination.prepare(sql).all().map(row => JSON.parse(row.payload_json)),
          f.writer.prepare(sql).all().map(row => JSON.parse(row.payload_json)))
      }
    } finally { destination.close() }
    assert.deepEqual({ main: digest(f.path), wal: digest(`${f.path}-wal`) }, before)
    // Source hydration is complete, then source legacy history advances. The
    // next generation resets durable markers AND original process caches.
    f.writer.prepare(`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES (?, ?, 'user', ?, 0, ?, ?)`)
      .run('later:message', f.ids[0], 'after completed hydration', '2021-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z')
    const next = await capture(f)
    assert.notEqual(next.generation, first.generation)
    assert.equal((await projection(f, next.generation)).messages.length, 361)
    await resumeRetainedT3(f.ports, f.manifest, f.source.admittedRootKey, next.generation)
    const full = await projection(f, next.generation)
    assert.equal(full.messages.filter(message => message.id === 'later:message').length, 1)
    const own = new DatabaseSync(f.destination(next.generation), { readOnly: true })
    try {
      assert.equal(own.prepare('SELECT COUNT(*) AS n FROM orchestration_v2_effect_outbox').get().n, 0)
      assert.equal(own.prepare('SELECT COUNT(*) AS n FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NULL').get().n, 0)
      assert.equal(own.prepare('SELECT COUNT(*) AS n FROM orchestration_v2_thread_launch_workflows').get().n, 0)
      assert.equal(own.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0)
    } finally { own.close() }
  } finally { f.close() }
})

test('actual original hydration interruption resumes one generation without duplicate original event/message IDs', async () => {
  const f = await engineFixture({ messages: 4 })
  const append = f.writer.prepare(`INSERT INTO projection_thread_messages
    (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES (?, ?, 'user', ?, 0, ?, ?)`)
  for (let index = 4; index < 360; index++) {
    const at = new Date(Date.UTC(2020, 0, 1, 0, index)).toISOString()
    append.run(`message:${index}`, f.ids[0], `ordinary transcript ${index} 雪`, at, at)
  }
  const create = f.ports.workspace.createGeneration
  f.ports.workspace.createGeneration = async generation => {
    const stage = await create(generation)
    await runSql(f.destination(generation), Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE TRIGGER synthetic_import_failure BEFORE INSERT ON orchestration_events
        WHEN NEW.event_id = 'migration:v1:message:message:150'
        BEGIN SELECT RAISE(ABORT, 'synthetic interruption'); END`)
    }))
    return stage
  }
  try {
    await assert.rejects(capture(f), /hydration_incomplete/u)
    const root = f.ports.journal.root(f.source.physicalRootKey)
    assert.equal(root.catalog_generation, null)
    assert.equal(f.ports.journal.generation(root.generation).phase, 'captured')
    // Remove only the disposable fault-injection trigger, never a live work item.
    await runSql(f.destination(root.generation), Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe('DROP TRIGGER synthetic_import_failure')
    }))
    await resumeRetainedT3(f.ports, f.manifest, f.source.admittedRootKey, root.generation)
    const read = await projection(f, root.generation)
    assert.equal(read.messages.length, 360)
    assert.equal(new Set(read.messages.map(message => message.id)).size, 360)
  } finally { f.close() }
})

test('registered structural privacy correlates later requests, cross-record native callId/replay and refuses exhaustion', async () => {
  const f = await engineFixture({ messages: 4 })
  const canary = 'synthetic-secret-canary 雪'
  const toolName = 'mcp__t3_code__request_secret'
  assert.equal(RequestPrivacy.isSecretRequestTool(toolName), true)
  try {
    const base = JSON.parse(f.writer.prepare('SELECT payload_json FROM orchestration_v2_projection_turn_items LIMIT 1').get().payload_json)
    const item = (id, ordinal, tool, input, output, nativeId = id) => ({ ...base, id, ordinal, type: 'dynamic_tool',
      nativeItemRef: { driver: 'codex', nativeId, strength: 'strong' }, toolName: tool, input, output })
    const payloads = [
      item('result-before-request', 1000, null, { id: 'rpc:later', result: { contentItems: [{ text: canary }] } }, null),
      item('native-result', 1001, null, {}, canary, 'native:later'),
      item('secret-tool', 1002, toolName, { value: canary, label: 'API key' }, { secret: canary }, 'native:later'),
      item('request-later', 1003, 'ordinary', { id: 'rpc:later', method: 'item/tool/call',
        params: { name: toolName, callId: 'native:later', arguments: { value: canary } } }, null),
    ]
    const insert = f.writer.prepare(`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json) VALUES (?, ?, ?, 'dynamic_tool', 'completed', ?, ?)`)
    for (const value of payloads) insert.run(value.id, f.ids[0], value.ordinal, '2020-01-01T00:00:00.000Z', JSON.stringify(value))
    const request = { id: 'request:inert', nodeId: 'node:inert', providerTurnId: null,
      nativeRequestRef: { driver: 'codex', nativeId: 'callback:old', strength: 'strong' }, kind: 'user_input',
      status: 'pending', responseCapability: { type: 'live', providerSessionId: 'session:old' },
      createdAt: '2020-01-01T00:00:00.000Z', resolvedAt: null }
    f.writer.prepare(`INSERT INTO orchestration_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES (?, ?, ?, 'user_input', 'pending', ?, ?)`).run(request.id, f.ids[0], request.nodeId,
      request.createdAt, JSON.stringify(request))
    const captured = await capture(f)
    const own = new DatabaseSync(f.destination(captured.generation), { readOnly: true })
    try {
      for (const table of ['orchestration_v2_projection_turn_items', 'orchestration_events']) {
        assert.equal(own.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE instr(payload_json, ?) > 0`).get(canary).n, 0)
      }
      const inert = JSON.parse(own.prepare('SELECT payload_json FROM orchestration_v2_projection_runtime_requests').get().payload_json)
      assert.equal(inert.responseCapability.type, 'not_resumable')
      assert.equal(inert.nativeRequestRef, null)
    } finally { own.close() }
    for (const path of [f.destination(captured.generation), `${f.destination(captured.generation)}-wal`]) {
      if (existsSync(path)) assert.equal(readFileSync(path).includes(Buffer.from(canary)), false)
    }
    const full = await projection(f, captured.generation)
    assert.ok(full.messages.some(message => message.text === 'ordinary transcript 0 雪'))
    const huge = item('over-budget', 2000, toolName, { value: 'x'.repeat(1024 * 1024 + 1) }, null)
    insert.run(huge.id, f.ids[0], huge.ordinal, '2020-01-01T00:00:00.000Z', JSON.stringify(huge))
    await assert.rejects(capture(f), /privacy_incomplete/u)
    assert.equal(f.ports.journal.root(f.source.physicalRootKey).last_ready_generation, captured.generation)
  } finally { f.close() }
})

test('original page input/output remains typed and unbound owner denies before reading', async () => {
  const f = await engineFixture()
  try {
    const captured = await capture(f)
    const full = await projection(f, captured.generation)
    assert.equal(full.messages.length, 360)
    // Actual original cursor and page shape; no local reducer/page DTO.
    const window = new DatabaseSync(f.destination(captured.generation), { readOnly: true })
    try {
      assert.ok(window.prepare('SELECT COUNT(*) AS n FROM orchestration_v2_projection_turn_items').get().n > 200)
    }
    finally { window.close() }
    const snapshot = await readRetainedSnapshotWindow(f.ports, f.manifest,
      f.source.admittedRootKey, captured.generation,
      S.ThreadId.make(f.ids[0]), { rowLimit: 25 })
    const bounded = ThreadStream.buildBoundedThreadStreamSnapshot({ ...snapshot,
      compactTurnItems: true, dedupeBodies: true, compactIds: true })
    const ids = new Set(snapshot.projection.visibleTurnItems.map(row => row.sourceItemId))
    const cursors = new Set()
    let cursor = bounded.historyCursor
    while (cursor) {
      assert.equal(cursors.has(cursor), false)
      cursors.add(cursor)
      const page = await readRetainedHistoryPage(f.ports, f.manifest, f.source.admittedRootKey,
        captured.generation, S.ThreadId.make(f.ids[0]), cursor)
      for (const row of page.items) ids.add(row.sourceItemId)
      cursor = page.nextCursor
    }
    assert.equal(ids.size, 360)
    assert.ok(cursors.size > 1)
    const original = f.ports.originalOwner
    f.ports.originalOwner = undefined
    await assert.rejects(projection(f, captured.generation), /required_retained_read_producers/u)
    f.ports.originalOwner = original
  } finally { f.close() }
})

test('original v2 authority preserves independent local/delegated/remote lineage, orphans and native overlay histories', async () => {
  const f = await engineFixture({ messages: 4 })
  try {
    const template = f.writer.prepare('SELECT * FROM orchestration_v2_projection_threads WHERE thread_id = ?').get(f.ids[0])
    const base = JSON.parse(template.payload_json)
    const child = { ...base, id: 'child:retained', historyOrigin: 'native', tags: ['hidden'],
      lineage: { parentThreadId: f.ids[2], relationshipToParent: 'subagent', rootThreadId: f.ids[2] },
      delegatedFrom: { environmentId: 'elsewhere:one', threadId: 'remote:parent', title: 'Remote parent' } }
    const orphan = { ...child, id: 'orphan:retained',
      lineage: { parentThreadId: 'absent:parent', relationshipToParent: 'subagent', rootThreadId: 'absent:parent' } }
    const columns = Object.keys(template)
    const insert = f.writer.prepare(`INSERT INTO orchestration_v2_projection_threads
      (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    for (const value of [child, orphan]) {
      const row = { ...template, thread_id: value.id, payload_json: JSON.stringify(value) }
      insert.run(...columns.map(column => row[column]))
    }
    // A legacy row in the same file must not overwrite current v2 title or graph.
    f.writer.prepare('UPDATE orchestration_v2_projection_threads SET title = ?, payload_json = ? WHERE thread_id = ?')
      .run('V2 authoritative', JSON.stringify({ ...base, title: 'V2 authoritative' }), f.ids[0])
    f.writer.prepare('UPDATE projection_threads SET title = ? WHERE thread_id = ?').run('obsolete legacy title', f.ids[0])
    const remoteChild = { environmentId: 'elsewhere:two', threadId: 'remote:child', label: 'Remote child' }
    const subagent = { id: 'subagent:retained', threadId: f.ids[0], runId: null, parentNodeId: 'node:parent',
      origin: 'app_owned', createdBy: 'agent', driver: 'codex', providerInstanceId: 'disabled-unbound',
      providerThreadId: null, childThreadId: child.id, remoteChild, nativeTaskRef: null, prompt: 'Synthetic task',
      title: null, model: null, status: 'completed', result: 'Synthetic result', startedAt: null, completedAt: null,
      updatedAt: '2020-01-01T00:00:00.000Z' }
    f.writer.prepare(`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json, driver, provider_instance_id)
      VALUES (?, ?, ?, 'codex', 'app_owned', 'completed', ?, ?, 'codex', 'disabled-unbound')`)
      .run(subagent.id, f.ids[0], subagent.parentNodeId, subagent.updatedAt, JSON.stringify(subagent))
    for (const [index, appThreadId] of [f.ids[0], f.ids[1], f.ids[2]].entries()) {
      const provider = { id: `provider:${index}`, driver: 'codex', providerInstanceId: 'disabled-unbound',
        providerSessionId: null, appThreadId, ownerNodeId: null,
        nativeThreadRef: { driver: 'codex', nativeId: 'same-native', strength: 'strong' },
        nativeConversationHeadRef: null, status: 'not_loaded', firstRunOrdinal: null, lastRunOrdinal: null,
        handoffIds: [], forkedFrom: null, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }
      f.writer.prepare(`INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver, provider_instance_id)
        VALUES (?, ?, 'codex', 'not_loaded', ?, ?, 'codex', 'disabled-unbound')`)
        .run(provider.id, appThreadId, provider.updatedAt, JSON.stringify(provider))
    }
    // Synthetic fixture port only; no production home/custody authority is asserted.
    f.ports.nativeHomes = { proveHomes: async ({ providerThread }) => ({ continuationHomeKey: 'synthetic:shared-home',
      historyHomeKey: `synthetic:overlay:${providerThread.id}`, homeProofReference: 'synthetic:home-proof' }) }
    const captured = await capture(f)
    const full = await projection(f, captured.generation)
    assert.equal(full.thread.title, 'V2 authoritative')
    assert.deepEqual(full.subagents.find(row => row.id === subagent.id).remoteChild, remoteChild)
    const retainedChild = await readRetainedProjection(f.ports, f.manifest, f.source.admittedRootKey,
      captured.generation, S.ThreadId.make(child.id))
    assert.deepEqual(retainedChild.thread.lineage, child.lineage)
    assert.deepEqual(retainedChild.thread.delegatedFrom, child.delegatedFrom)
    assert.ok(f.ports.journal.catalog(f.source.physicalRootKey).some(row => row.thread_id === orphan.id))
    const journal = new DatabaseSync(`${f.directory}/local-capture-journal.sqlite`, { readOnly: true })
    try {
      const aliases = journal.prepare('SELECT * FROM t3_capture_native_aliases ORDER BY thread_id').all()
      assert.equal(aliases.length, 3)
      assert.equal(new Set(aliases.map(row => row.thread_id)).size, 3)
      assert.equal(new Set(aliases.map(row => row.continuation_home)).size, 1)
      assert.equal(new Set(aliases.map(row => row.history_home)).size, 3)
    } finally { journal.close() }
  } finally { f.close() }
})
