import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { captureRetainedT3 } from '../../dist/t3-session/import/capture.js'
import { capturedCatalogPage, RETAINED_PUBLICATION_PAGE_SIZE } from '../../dist/t3-session/catalog/publication-rows.js'
import { withRetainedCatalogPublication } from '../../dist/t3-session/catalog/publication-scope.js'
import { engineFixture } from '../t3-session-import/engine-fixture.mjs'

const owner = { scope: 'environment-owner', basis: 'prospective-import-grant', revision: 'synthetic:publish:1' }
const fixture = async options => {
  const f = await engineFixture(options)
  const capture = await captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
  const input = { source: f.source, captureGeneration: capture.generation,
    sourceHighWater: capture.watermark.sequence,
    localCatalogReference: f.ports.journal.generation(capture.generation).stage_ref }
  f.ports.catalogPublicationAuthority = { withCatalogPublicationScope: async (request, use) => {
    assert.equal(request.purpose, 'retained-catalog-publish')
    return use({ selection: owner, publicationGrantId: 'synthetic:grant', selectionKey: owner.revision,
      recheckSelection: async () => {},
      recheckSource: async () => {}, recheckThread: async () => {} })
  } }
  return { ...f, input }
}

test('publication enumerates over 5000 captured identities in original SQLite order with bounded pages', async () => {
  const f = await fixture({ threads: 5005, messages: 0 })
  try {
    const expected = f.writer.prepare(`SELECT thread_id FROM orchestration_v2_projection_threads
      ORDER BY updated_at ASC, thread_id ASC`).all().map(row => row.thread_id)
    const collected = []
    await withRetainedCatalogPublication(f.ports, f.manifest, f.input, new AbortController().signal,
      held => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql.withTransaction(Effect.gen(function* () {
          let cursor
          while (true) {
            const page = yield* capturedCatalogPage(held.selection, cursor)
            assert.ok(page.entries.length <= RETAINED_PUBLICATION_PAGE_SIZE)
            if (!page.entries.length) break
            for (const entry of page.entries) yield* Effect.promise(() => held.recheckThread(entry.threadId))
            collected.push(...page.entries)
            cursor = page.next
          }
        }))
      }).pipe(Effect.provide(held.stage.sql)))))
    assert.equal(collected.length, 5007)
    assert.deepEqual(collected.map(entry => entry.threadId), expected)
    assert.equal(collected.find(entry => entry.threadId === f.ids[1]).state, 'archived')
    assert.equal(collected.find(entry => entry.threadId === f.ids[2]).state, 'deleted')
  } finally { f.close() }
})

test('publication scope rejects forged local references and lacks no publication-to-read fallback', async () => {
  const f = await fixture({ messages: 0 })
  try {
    const run = input => withRetainedCatalogPublication(f.ports, f.manifest, input,
      new AbortController().signal, async () => { throw new Error('must not enumerate') })
    await assert.rejects(run({ ...f.input, localCatalogReference: '/arbitrary/local/file' }), /reference_mismatch/u)
    await assert.rejects(run({ ...f.input, sourceHighWater: f.input.sourceHighWater + 1 }), /reference_mismatch/u)
    delete f.ports.catalogPublicationAuthority
    await assert.rejects(run(f.input), /required_retained_publication_producers/u)
  } finally { f.close() }
})

test('partial and empty publication enumeration never touches hidden journal identities', async () => {
  const f = await fixture({ threads: 400, messages: 0 })
  try {
    for (const ids of [[f.ids[2], f.ids[200], ...f.ids.slice(-2)], []]) {
      f.ports.catalogPublicationAuthority = { withCatalogPublicationScope: async (_request, use) => use({
        selection: { ...owner, scope: 'threads', threadIds: ids, projectIds: [] },
        publicationGrantId: 'synthetic:grant', selectionKey: owner.revision,
        recheckSource: async () => {}, recheckThread: async id => { assert.ok(ids.includes(id)) },
        recheckSelection: async () => {},
      }) }
      f.ports.journal.catalog = () => { throw new Error('must not enumerate the global journal') }
      const result = await withRetainedCatalogPublication(f.ports, f.manifest, f.input, new AbortController().signal,
        held => Effect.runPromise(Effect.scoped(capturedCatalogPage(held.selection).pipe(Effect.provide(held.stage.sql)))))
      assert.deepEqual(new Set(result.entries.map(entry => entry.threadId)), new Set(ids))
    }
  } finally { f.close() }
})
