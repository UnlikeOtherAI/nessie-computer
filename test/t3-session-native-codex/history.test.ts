import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexRetainedHistory, type CodexHistoryCursor, type CodexRolloutBytes } from '../../src/t3-session/native-sources/codex/history.js'
import { codexIdentity } from '../../src/t3-session/native-sources/codex/identity.js'

const identity = codexIdentity({ executorId: 'computer:a', continuationHomeKey: 'home:a', historyHomeKey: 'history:a' }, 'native:雪')
const record = (type: string, payload: Record<string, unknown>) => ({ timestamp: '2020-01-01T00:00:00Z', type, payload })
const header = record('session_meta', { id: identity.nativeId, source: 'cli' })
const response = (payload: Record<string, unknown>) => record('response_item', payload)
const message = (text: string) => response({ type: 'message', id: `message:${text.slice(0, 20)}`, role: 'assistant',
  content: [{ type: 'output_text', text }] })

function fixture(rows: unknown[], suffix = '') {
  const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n' + suffix)
  let revoked = false
  const reads: { offset: number; length: number }[] = []
  const source: CodexRolloutBytes = { identity, resourceRevision: 'resource:one', capturedBytes: bytes.length,
    async read(offset, length) { reads.push({ offset, length }); return bytes.subarray(offset, offset + length) },
    async recheck() { if (revoked) throw new Error('revoked') } }
  return { source, reads, revoke: () => { revoked = true } }
}

test('native history pages beyond the old tail and 200-message limit with exact Unicode byte positions', async () => {
  const f = fixture([header, ...Array.from({ length: 250 }, (_, i) => message(`${i}: česky 雪 ${'x'.repeat(5000)}`))])
  const history = new CodexRetainedHistory(f.source)
  await history.prepare()
  let cursor: CodexHistoryCursor | undefined
  const offsets: number[] = []
  do {
    const page = await history.page({ cursor, limit: 11 })
    assert.equal(page.completeness, 'complete-supported-prefix')
    offsets.push(...page.entries.map(entry => entry.offset))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert.equal(offsets.length, 251)
  assert.equal(new Set(offsets).size, 251)
  assert.equal(offsets[0], 0)
  assert.ok(f.reads.every(read => read.length <= 64 * 1024))
})

test('complete privacy preflight redacts an output even when its secret call comes later', async () => {
  const f = fixture([header, response({ type: 'function_call_output', call_id: 'secret:1', output: 'CANARY-ANSWER' }),
    response({ type: 'function_call', call_id: 'secret:1', name: 'mcp__t3_code__request_secret',
      arguments: JSON.stringify({ value: 'CANARY-ARGUMENT' }) })])
  const history = new CodexRetainedHistory(f.source)
  await history.prepare()
  assert.doesNotMatch(JSON.stringify(await history.page()), /CANARY/u)
})

test('unknown historical question values are withheld while descriptors and exact call IDs remain', async () => {
  const f = fixture([header, response({ type: 'function_call', call_id: 'q:1', name: 'request_user_input', arguments: JSON.stringify({
    questions: [{ id: 'exact:q', header: 'Volba', question: 'Kterou možnost?', initialAnswer: 'CANARY-INITIAL',
      options: [{ label: 'První', description: 'Popis', value: 'CANARY-OPTION', preview: 'CANARY-PREVIEW' }] }],
  }) }), response({ type: 'function_call_output', call_id: 'q:1', output: 'CANARY-ANSWER' })])
  const history = new CodexRetainedHistory(f.source)
  await history.prepare()
  const result = JSON.stringify(await history.page())
  assert.doesNotMatch(result, /CANARY/u)
  assert.match(result, /Kterou možnost/u)
  assert.match(result, /exact:q/u)
  assert.match(result, /WITHHELD:UNKNOWN_QUESTION_PRIVACY/u)
})

test('partial trailing writes and unsupported records never report complete retained history', async () => {
  const f = fixture([header, record('future_record', { unsafe: 'CANARY' }), record('event_msg', {
    type: 'token_count', info: { tokens: 'CANARY' }, rate_limits: 'CANARY',
  })], '{"type":')
  const history = new CodexRetainedHistory(f.source)
  await history.prepare()
  const page = await history.page()
  assert.equal(page.completeness, 'partial-final-record')
  assert.equal(page.unsupportedRecords, 1)
  assert.equal(page.entries[1]?.omission, 'unsupported')
  assert.equal(page.entries[2]?.omission, 'excluded')
  assert.doesNotMatch(JSON.stringify(page), /CANARY/u)
})

test('wrong identity, malformed complete records, stale cursors and revoked reads fail closed', async () => {
  const wrong = new CodexRetainedHistory(fixture([record('session_meta', { id: 'other' })]).source)
  await assert.rejects(wrong.prepare(), /codex_rollout_identity_mismatch/u)
  const broken = new CodexRetainedHistory(fixture([header], '{bad}\n').source)
  await assert.rejects(broken.prepare(), /codex_record_invalid_json/u)
  const f = fixture([header, message('first'), message('second')])
  const history = new CodexRetainedHistory(f.source)
  await history.prepare()
  const cursor = (await history.page({ limit: 1 })).nextCursor!
  await assert.rejects(history.page({ cursor: { ...cursor, resourceRevision: 'other' } }), /codex_cursor_stale/u)
  await assert.rejects(history.page({ cursor: { ...cursor, offset: 3 } }), /codex_cursor_not_record_boundary/u)
  f.revoke()
  await assert.rejects(history.page({ cursor }), /revoked/u)
})

test('explicitly public native questions keep their original answer and raw private reasoning is omitted', async () => {
  const f = fixture([header, response({ type: 'function_call', call_id: 'public', name: 'request_user_input', arguments: JSON.stringify({
    questions: [{ id: 'choice', question: 'Pick', isSecret: false, initialAnswer: 'public-choice' }],
  }) }), response({ type: 'function_call_output', call_id: 'public', output: 'public-choice' }),
  response({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'supported summary' }], encrypted_content: 'CANARY' })])
  const history = new CodexRetainedHistory(f.source)
  await history.prepare()
  const result = JSON.stringify(await history.page())
  assert.match(result, /public-choice/u)
  assert.match(result, /supported summary/u)
  assert.doesNotMatch(result, /CANARY/u)
})

test('empty question declarations cannot assert public answer classification', async () => {
  const f = fixture([header, response({ type: 'function_call', call_id: 'empty', name: 'request_user_input',
    arguments: JSON.stringify({ questions: [] }) }),
  response({ type: 'function_call_output', call_id: 'empty', output: 'CANARY' })])
  const history = new CodexRetainedHistory(f.source)
  await history.prepare()
  assert.doesNotMatch(JSON.stringify(await history.page()), /CANARY/u)
})

test('cancellation before and during paging publishes nothing and performs no subsequent read', async () => {
  const f = fixture([header, message('first'), message('second')])
  const before = new AbortController()
  before.abort(new Error('cancelled-before'))
  await assert.rejects(new CodexRetainedHistory(f.source).prepare(before.signal), /cancelled-before/u)
  assert.equal(f.reads.length, 0)
  const history = new CodexRetainedHistory(f.source)
  await history.prepare()
  const after = new AbortController()
  const original = f.source.read
  let cancelDuringRead = false
  const source = { ...f.source, async read(offset: number, length: number) {
    const bytes = await original(offset, length)
    if (cancelDuringRead) after.abort(new Error('cancelled-during'))
    return bytes
  } }
  const cancellable = new CodexRetainedHistory(source)
  await cancellable.prepare()
  const reads = f.reads.length
  cancelDuringRead = true
  await assert.rejects(cancellable.page({ signal: after.signal }), /cancelled-during/u)
  assert.equal(f.reads.length, reads + 1)
  await assert.rejects(cancellable.page({ signal: after.signal }), /cancelled-during/u)
  assert.equal(f.reads.length, reads + 1)
})
