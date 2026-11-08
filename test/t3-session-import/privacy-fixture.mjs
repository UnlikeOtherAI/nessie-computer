import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tablesForLayout } from '../../dist/t3-session/import/layout.js'

export const at = '2020-01-01T00:00:00.000Z'
export const canary = 'synthetic-mask-only-秘密-7a2'
export const ordinary = 'obyčejná odpověď, keep exactly'

export function addQuestion(f, { thread = f.ids[0], request = 'request:masked',
  id = `item:${request}:${thread}`, mask = true, answer = canary, ordinal = 1000 } = {}) {
  const base = JSON.parse(f.writer.prepare('SELECT payload_json FROM orchestration_v2_projection_turn_items LIMIT 1')
    .get().payload_json)
  const value = { ...base, id, threadId: thread, type: 'user_input_request', requestId: request, ordinal,
    questions: [{ id: 'q:reused', header: 'Synthetic', question: 'Synthetic field',
      options: [{ label: 'Synthetic option', description: 'Synthetic description', value: answer, preview: answer }],
      ...(mask === undefined ? {} : { isSecret: mask }), initialAnswer: answer }],
    questionAnswer: { requestId: request, answers: { 'q:reused': [answer] }, attachmentsByQuestionId: {} } }
  f.writer.prepare(`INSERT INTO orchestration_v2_projection_turn_items
    (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
    VALUES (?, ?, ?, 'user_input_request', 'completed', ?, ?)`).run(id, thread, ordinal, at, JSON.stringify(value))
  return value
}

export function addAnswer(f, { thread = f.ids[0], request = 'request:masked', answer = canary } = {}) {
  const value = { id: request, nodeId: 'node:synthetic', providerTurnId: null, nativeRequestRef: null,
    kind: 'user_input', status: 'resolved', responseCapability: { type: 'message' },
    createdAt: at, resolvedAt: at, answers: { 'q:reused': [answer] } }
  f.writer.prepare(`INSERT INTO orchestration_v2_projection_runtime_requests
    (runtime_request_id, thread_id, node_id, kind, status, created_at, resolved_at, payload_json)
    VALUES (?, ?, ?, 'user_input', 'resolved', ?, ?, ?)`).run(request, thread, value.nodeId, at, at, JSON.stringify(value))
  return value
}

export function addEvent(f, type, payload, thread = f.ids[0]) {
  const template = f.writer.prepare('SELECT * FROM orchestration_events ORDER BY sequence LIMIT 1').get()
  const version = f.writer.prepare('SELECT COALESCE(MAX(stream_version), 0) AS n FROM orchestration_events WHERE stream_id = ?')
    .get(thread).n + 1
  const row = { ...template, event_id: `synthetic:event:${thread}:${version}`, stream_id: thread,
    stream_version: version, event_type: type, payload_json: JSON.stringify(payload),
    aggregate_kind: 'thread', application_event_version: 2 }
  delete row.sequence
  const columns = Object.keys(row)
  f.writer.prepare(`INSERT INTO orchestration_events (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...columns.map(column => row[column]))
  return row.event_id
}

/** Inspect SQLite logical exports and raw main/WAL/journal bytes, excluding only
 * the intentionally sensitive synthetic source. Never print tested values.
 */
export function assertDestinationsClean(f) {
  for (const name of readdirSync(f.directory)) {
    if (name.startsWith('synthetic-source.sqlite')) continue
    const path = join(f.directory, name)
    assert.equal(readFileSync(path).includes(Buffer.from(canary)), false, 'masked bytes in owned artifact')
    if (!name.endsWith('.sqlite')) continue
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      for (const { name: table } of database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()) {
        const rows = database.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all()
        assert.equal(JSON.stringify(rows).includes(canary), false, 'masked bytes in SQLite export')
      }
    } finally { database.close() }
  }
}

export function assertGenerationEmpty(f, generation) {
  const path = f.destination(generation)
  if (!existsSync(path)) return
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    for (const { name } of tablesForLayout('v2-80')) {
      // Original migrations initialize projection metadata, not session rows.
      if (name === 'orchestration_v2_projection_metadata') continue
      assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n, 0, name)
    }
  } finally { database.close() }
}
