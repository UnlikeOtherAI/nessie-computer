import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { withOriginalState } from './outbox-fixture.mjs'
import { seedShutdownThread } from './shutdown-fixture.mjs'

// Explicit fixture production from the actual pinned original migrations and
// event codecs. All records are synthetic; this is not graph or human authority.
const queries = JSON.parse(await readFile(new URL('../../windows-common/src/execution_recovery_queries.json',
  import.meta.url), 'utf8'))
const threadId = 'recovery:雪'
const fixture = await withOriginalState(Effect.gen(function* () {
  yield* seedShutdownThread(threadId)
  yield* seedShutdownThread('unselected')
  const sql = yield* SqlClient.SqlClient
  const names = queries.tables.map(() => '?').join(',')
  const schema = yield* sql.unsafe(`SELECT sql FROM sqlite_schema WHERE tbl_name IN (${names})
    AND type IN ('table', 'index') AND sql IS NOT NULL ORDER BY type DESC, name`, queries.tables)
  const tables = {}
  for (const name of queries.tables) tables[name] = (yield* sql.unsafe(`SELECT * FROM ${name}`)).map(row => ({ ...row }))
  const thread = (yield* sql.unsafe(queries.thread.query, [threadId]))[0].payload_json
  const rows = []
  for (const query of queries.sections) {
    const values = yield* sql.unsafe(query.query, Array(query.parameters).fill(threadId))
    for (const row of values) rows.push([query.section, row.payload_json])
  }
  const encoded = JSON.stringify(['nessie.t3.runtime-recovery-inputs.v1', threadId, thread, rows])
  return { sourceCommit: '25bf84ab07f53f141c20239c63e383823a9d5ea0', schema: schema.map(row => row.sql), tables,
    threadId, inputDigest: 'sha256:' + createHash('sha256').update(encoded, 'utf8').digest('hex'),
    rawThread: thread, rawSections: rows }
}))
await writeFile(new URL('./fixtures/recovery-projection-inputs.json', import.meta.url),
  JSON.stringify(fixture, null, 2) + '\n')
console.log(JSON.stringify({ tables: queries.tables.length, rows: fixture.rawSections.length,
  inputDigest: fixture.inputDigest }))
