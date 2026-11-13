import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { withSourceSnapshotView } from '../../dist/t3-session/import/snapshot-view.js'
import { tablesForLayout, legacyThreads, legacyMessages, legacyPullRequests, selectCaptureRows }
  from '../../dist/t3-session/import/layout.js'
import { withSessionExecutionState } from '../../dist/t3-session/runtime/execution-state.js'

const source = { admittedRootKey: 'root', physicalRootKey: 'physical', environmentId: 'original-env',
  layout: 'v2-80', databaseRole: 'authoritative-v2' }

test('shared view retains the original full frozen-legacy fingerprint inside a producer transaction', async () => {
  const reads = []
  let closed = 0, transactions = 0, escaped, iterator
  const row = { thread_id: 'legacy-outside-import-view' }
  const database = {
    exec() { transactions++; throw new Error('producer owns the transaction') },
    prepare(sql) {
      reads.push(sql)
      const rows = sql === selectCaptureRows(legacyThreads) ? [row] : []
      return { *iterate() { try { yield* rows } finally { closed++ } } }
    },
  }
  await withSourceSnapshotView(database, source, 42, () => {}, async view => {
    escaped = view
    const tables = tablesForLayout(source.layout)
    const expected = createHmac('sha256', 'key')
    expected.update(JSON.stringify(['t3-capture-snapshot-v1', source.layout, 0]))
    for (const table of [legacyThreads, legacyMessages, legacyPullRequests]) {
      expected.update(JSON.stringify([table.name, table.columns]))
      if (table === legacyThreads) {
        expected.update(JSON.stringify(table.columns.map(column => row[column])))
        expected.update('\n')
      }
    }
    assert.equal(view.fingerprint('key').legacyDigest, expected.digest('hex'))
    assert.ok(reads.includes(selectCaptureRows(legacyThreads)))
    assert.ok(reads.includes(selectCaptureRows(tables.find(table => table.name === legacyThreads.name))))
    assert.throws(() => [...view.rows(legacyThreads)], /source_snapshot_closed_or_table_not_admitted/u)
    iterator = view.rows(view.tables[0])[Symbol.iterator]()
    assert.equal(transactions, 0)
  })
  assert.ok(closed > 0)
  assert.throws(() => escaped.fingerprint('key'), /source_snapshot_closed_or_table_not_admitted/u)
  assert.throws(() => iterator.next(), /source_snapshot_closed_or_table_not_admitted/u)
  assert.equal(transactions, 0)
})

test('execution import refuses a forged resource before opening storage or invoking its source callback', async () => {
  let invoked = false
  const fake = { receipt: {}, signal: new AbortController().signal,
    recheck: async () => { invoked = true },
    withReadonlySourceSnapshot: async () => { invoked = true },
  }
  await assert.rejects(withSessionExecutionState(fake, 'not-an-absolute-storage-root',
    async () => { invoked = true }, new AbortController().signal), /t3_execution_resource_not_issued/u)
  assert.equal(invoked, false)
})
