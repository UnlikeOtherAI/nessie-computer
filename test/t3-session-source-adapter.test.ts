import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseT3Homes } from '../src/t3-session/source/configuration.js'
import { heldSourceDatabase } from '../src/t3-session/source/database.js'
import { legacyMessages, selectCaptureRows, tablesForLayout } from '../src/t3-session/import/layout.js'

test('configuration preserves explicit aliases and unavailable roots without scanning', () => {
  const entries = [
    { admittedRootKey: 'a', kind: 'configured-home', stateDirectory: 'C:\\fixtures\\userdata' },
    { admittedRootKey: 'b', kind: 'configured-home', stateDirectory: 'C:\\FIXTURES\\userdata' },
    { admittedRootKey: 'offline', kind: 'server-home', stateDirectory: 'D:\\missing\\userdata' },
  ]
  assert.deepEqual(parseT3Homes(entries), entries)
  assert.deepEqual(parseT3Homes([]), [])
  assert.throws(() => parseT3Homes([entries[0], entries[0]]))
  for (const stateDirectory of ['C:\\fixtures\\..\\userdata', '\\\\server\\userdata',
    'C:\\fixtures\\userdata:stream', 'C:\\fixtures\\userdata.', 'relative\\userdata', 'C:\\fixtures\\dev']) {
    assert.throws(() => parseT3Homes([{ ...entries[0], stateDirectory }]))
  }
})

test('adapter sends closed named reads, preserves row order and cannot send SQL to the receiver', () => {
  // Protocol codec test only: this exchange is not physical-source admission.
  const calls: Record<string, unknown>[] = []
  const rows = [{ message_id: 'opaque:雪', created_at: '2001-01-01' }, { message_id: 'b', created_at: '2001-01-02' }]
  let index = 0
  const database = heldSourceDatabase(request => {
    calls.push(request)
    if (request.op === 'query') { index = 0; return { statement: 1 } }
    if (request.op === 'next') return index < rows.length ? { row: rows[index++], done: false } : { done: true }
    return {}
  }, 'v2-80')
  assert.deepEqual(database.prepare(selectCaptureRows(legacyMessages)).all(), rows)
  assert.deepEqual(calls[0], { op: 'query', query: 'frozenLegacy', table: 'projection_thread_messages' })
  assert.equal(calls.at(-1)?.op, 'finalize')
  assert.throws(() => database.prepare('SELECT * FROM auth_sessions').all(), /not_admitted/u)
  assert.throws(() => database.prepare('SELECT name FROM pragma_table_info(?)').all('auth_sessions'), /not_admitted/u)
  assert.throws(() => database.exec('ATTACH DATABASE x'), /write_refused/u)
  assert.throws(() => database.prepare('anything').run(), /write_refused/u)
  for (const table of tablesForLayout('v2-80')) database.prepare(selectCaptureRows(table)).get()
  assert.ok(calls.every(request => !('sql' in request)))
})

test('iterator finalizes after early return or receiver rejection', () => {
  const calls: string[] = []
  const database = heldSourceDatabase(request => {
    calls.push(String(request.op))
    if (request.op === 'query') return { statement: 1 }
    if (request.op === 'next') throw new Error('revoked')
    return {}
  }, 'legacy-54')
  assert.throws(() => database.prepare(selectCaptureRows(legacyMessages)).get(), /revoked/u)
  assert.deepEqual(calls, ['query', 'next', 'finalize'])
})
