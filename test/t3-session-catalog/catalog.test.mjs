import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Effect from 'effect/Effect'
import * as DateTime from 'effect/DateTime'
import * as Schema from 'effect/Schema'
import { SourceContracts as S } from '@nessie/t3-session-source/engine'
import { ExecutorT3Descriptors as D, requireBoundExecutorT3Operation } from '@nessie/executor-protocol/t3-session'
import { retainedCatalogSlots } from '../../dist/t3-session/catalog/service.js'
import { catalogFixture } from './fixture.mjs'

const run = Effect.runPromise
const shell = f => f.service.http.shellSnapshot({ params: undefined, query: {} })

test('complete original shell exceeds 5000, keeps old tied settlements and exact opaque identities', async () => {
  const f = await catalogFixture({ threads: 5005, messages: 0 })
  try {
    const full = await run(shell(f))
    const archive = await run(f.service.rpc['orchestration.getArchivedShellSnapshot']({}))
    assert.equal(full.source, 't3')
    assert.equal(full.environmentId, f.source.environmentId)
    assert.equal(full.captureGeneration, f.capture.generation)
    assert.equal(full.sourceSequence, f.capture.watermark.sequence)
    const ids = [...full.value.threads, ...archive.value.threads].map(row => row.id)
    assert.equal(ids.length, 5006)
    assert.equal(new Set(ids).size, 5006)
    assert.deepEqual(new Set(ids), new Set(f.ids.filter(id => id !== f.ids[2])))
    assert.deepEqual(archive.value.threads.map(row => row.id), [f.ids[1]])
    const trimmed = await run(f.service.http.shellSnapshot({ params: undefined,
      query: { omitOlderSettled: '1', omitIdleSubagents: '1' } }))
    // The original cutoff keeps ties at position 25; a local slice(0, 25) would lose these.
    assert.deepEqual(trimmed.value.threads.map(row => row.id), full.value.threads.map(row => row.id))
    assert.equal(trimmed.value.olderSettled.counts.length, 0)
    await run(Schema.encodeEffect(S.OrchestrationV2ShellSnapshot)(full.value))
  } finally { f.close() }
})

test('settled pages retain exact original tie cursor and traverse every row without duplication', async () => {
  const f = await catalogFixture({ threads: 61, messages: 0 })
  try {
    const seen = new Set()
    let before = { settledAt: '2026-01-01T00:00:00.000Z' }
    for (let pageNumber = 0; ; pageNumber++) {
      assert.ok(pageNumber < 10, 'cursor must advance')
      const { value } = await run(f.service.rpc['orchestration.getOlderSettledThreads']({ before, limit: 17 }))
      if (!value.threads.length) break
      for (const row of value.threads) { assert.equal(seen.has(row.id), false); seen.add(row.id) }
      const last = value.threads.at(-1)
      before = { settledAt: DateTime.formatIso(last.settledAt), threadId: last.id }
    }
    assert.deepEqual(seen, new Set(f.ids.filter(id => id !== f.ids[1] && id !== f.ids[2])))
    const counts = await run(f.service.rpc['orchestration.getOlderSettledThreads']({
      before: { settledAt: '2026-01-01T00:00:00.000Z' }, limit: 0,
    }))
    assert.equal(counts.value.threads.length, 0)
    assert.equal(counts.value.counts.reduce((sum, row) => sum + row.count, 0), seen.size)
  } finally { f.close() }
})

test('canonical finite slots preserve original result codecs and refuse stream/mutation slots', async () => {
  const f = await catalogFixture({ messages: 3 })
  try {
    const slots = retainedCatalogSlots(f.service)
    const input = { threadId: S.ThreadId.make(f.ids[0]) }
    const value = await run(requireBoundExecutorT3Operation(slots, 'orchestration.getThreadProjection')(input))
    const encoded = await run(Schema.encodeEffect(D['orchestration.getThreadProjection'].successSchema)(value))
    assert.equal(encoded.thread.id, f.ids[0])
    for (const method of ['orchestration.subscribeShell', 'orchestration.subscribeThread',
      'orchestration.subscribeCommandOutput', 'orchestration.dispatchCommand']) {
      assert.throws(() => requireBoundExecutorT3Operation(slots, method), /NOT_BOUND/u)
    }
    const item = await run(slots['orchestration.getTurnItem']({ ...input,
      itemId: S.TurnItemId.make('migration:v1:turn-item:message:0') }))
    assert.ok(item.item)
    assert.equal(item.item.id, 'migration:v1:turn-item:message:0')
  } finally { f.close() }
})
