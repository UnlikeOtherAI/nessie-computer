import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Effect from 'effect/Effect'
import { publicationFixture, owner } from './publication-fixture.mjs'

// Actual engine/capture/graph/signed transport; synthetic source and authority.
// These fixtures do not qualify native source-owner consent or server admission.
test('held publication sends over 5000 identities in bounded original order and only opens captured SQL once', async () => {
  const f = await publicationFixture({ threads: 5005, messages: 0 })
  try {
    const expected = f.writer.prepare(`SELECT thread_id FROM orchestration_v2_projection_threads
      ORDER BY updated_at ASC, thread_id ASC`).all().map(row => row.thread_id)
    let opens = 0
    const reopen = f.ports.workspace.reopenGeneration
    f.ports.workspace.reopenGeneration = async ref => { opens++; return reopen(ref) }
    let escaped
    const receipt = await f.withGraph(async graph => {
      escaped = graph
      assert.equal(graph.readiness, 'retained-read-only')
      const receipt = await graph.publish(f.authority, () => f.state)
      const reads = graph.createReadService({ withCatalogReadScope: async (_input, use) => use({
        selection: owner, recheckSelection: async () => {}, recheckSource: async () => {},
        recheckThread: async () => { throw new Error('catalog selection must not exchange a lease per row') },
      }) })
      const archive = await Effect.runPromise(reads.rpc['orchestration.getArchivedShellSnapshot']({}))
      assert.equal(archive.value.threads[0].id, f.ids[1])
      return receipt
    })
    assert.equal(opens, 1)
    assert.equal(receipt.state, 'complete')
    assert.equal(receipt.totalEntries, 5007)
    assert.equal(receipt.totalPages, Math.ceil(5007 / 128))
    const entries = [...f.pages.values()].flatMap(page => page.entries)
    assert.ok([...f.pages.values()].every(page => page.entries.length <= 128))
    assert.deepEqual(entries.map(row => row.threadId), expected)
    assert.deepEqual(entries.map(row => row.rowOrdinal), expected.map((_id, i) => i))
    assert.equal(entries.find(row => row.threadId === f.ids[1]).sourceState, 'archived')
    assert.equal(entries.find(row => row.threadId === f.ids[2]).sourceState, 'deleted')
    assert.ok(f.exchanges.every(item => item.publication.scope === 'source'))
    assert.ok(f.exchanges.every(item => !('localCatalogReference' in item.publication)))
    await assert.rejects(escaped.recheck(), /closed/u)
    await assert.rejects(escaped.publish(f.authority, () => f.state), /closed/u)
  } finally { f.close() }
})

for (const empty of [false, true]) {
  test(`exact ${empty ? 'empty' : 'partial'} selection publishes no hidden IDs or whole-root completion`, async () => {
    const f = await publicationFixture({ threads: 400, messages: 0 })
    try {
      const ids = empty ? [] : [f.ids[2], f.ids[200], ...f.ids.slice(-2)]
      f.select({ ...owner, scope: 'threads', threadIds: ids, projectIds: [] })
      f.ports.journal.catalog = () => { throw new Error('must not enumerate global identities') }
      const receipt = await f.withGraph(graph => graph.publish(f.authority, () => f.state))
      assert.equal(receipt.totalEntries, ids.length)
      assert.deepEqual(new Set([...f.pages.values()].flatMap(page => page.entries.map(row => row.threadId))), new Set(ids))
      assert.ok(f.exchanges.every(item => item.publication.scope === 'selection' && item.publication.totalEntries === ids.length))
      assert.ok([...f.pages.values()].every(page => page.entries.every(row => row.mapping.projectRef === null)))
    } finally { f.close() }
  })
}

test('lost page response retries identical pages and snapshot digest without regenerating a publication', async () => {
  const f = await publicationFixture({ threads: 160, messages: 0 })
  try {
    let first = true
    f.onExchange(async payload => {
      if (first && payload.operation === 't3.catalog.page') { first = false; throw new Error('synthetic response lost') }
    })
    await assert.rejects(f.withGraph(graph => graph.publish(f.authority, () => f.state)), /synthetic response lost/u)
    const digest = f.exchanges[0].publication.snapshotDigest
    await f.withGraph(graph => graph.publish(f.authority, () => f.state))
    assert.ok(f.exchanges.every(item => item.publication.snapshotDigest === digest))
    assert.equal(f.exchanges.filter(item => item.operation === 't3.catalog.page' && item.page.pageOrdinal === 0).length, 2)
  } finally { f.close() }
})

for (const race of ['selection', 'generation', 'cancel']) {
  test(`${race} loss after a page response prevents catalog completion`, async () => {
    const f = await publicationFixture({ threads: 160, messages: 0 })
    const controller = new AbortController()
    try {
      f.onExchange(async payload => {
        if (payload.operation !== 't3.catalog.page') return
        if (race === 'selection') f.revoke()
        if (race === 'generation') f.ports.journal.begin(f.source, 'synthetic:newer', 'synthetic:stage')
        if (race === 'cancel') controller.abort(new Error('synthetic source lease lost'))
      })
      await assert.rejects(f.withGraph(graph => graph.publish(f.authority, () => f.state), controller.signal))
      assert.equal(f.exchanges.some(item => item.operation === 't3.catalog.complete'), false)
    } finally { f.close() }
  })
}

test('held graph drains the enclosing authority promise before releasing its source callback', async () => {
  const f = await publicationFixture({ messages: 0 })
  let entered
  let release
  const enteredPromise = new Promise(resolve => { entered = resolve })
  const released = new Promise(resolve => { release = resolve })
  let outcome
  try {
    const running = f.withGraph(async graph => {
      const reads = graph.createReadService({ withCatalogReadScope: async (_input, use) => {
        const value = await use({ selection: owner, recheckSelection: async () => {},
          recheckSource: async () => {}, recheckThread: async () => {} })
        entered()
        await released
        return value
      } })
      outcome = Effect.runPromise(reads.rpc['orchestration.getArchivedShellSnapshot']({})).catch(error => error)
      await enteredPromise
      return 'callback finished'
    })
    let settled = false
    void running.then(() => { settled = true }, () => { settled = true })
    await enteredPromise
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, 'outer owner callback must still hold the graph/source')
    release()
    assert.equal(await running, 'callback finished')
    assert.match(String(await outcome), /closed/u)
  } finally { release?.(); f.close() }
})

test('first local consent failure stays fatal even if the callback catches it and consent recovers', async () => {
  const f = await publicationFixture({ messages: 0 })
  try {
    await assert.rejects(f.withGraph(async graph => {
      const failure = new Error('synthetic local consent lost')
      f.onLocalRecheck(async () => { throw failure })
      await assert.rejects(graph.recheck(), /synthetic local consent lost/u)
      assert.equal(graph.signal.aborted, true)
      f.onLocalRecheck(async () => {})
      await assert.rejects(graph.recheck(), /synthetic local consent lost/u)
      return 'cannot recover a held graph'
    }), /synthetic local consent lost/u)
  } finally { f.close() }
})
