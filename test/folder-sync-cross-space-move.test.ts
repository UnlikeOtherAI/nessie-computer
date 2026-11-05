import assert from 'node:assert/strict'
import { mkdir, rename } from 'node:fs/promises'
import test from 'node:test'

import { EXECUTOR_FOLDER_SYNC_ERROR_CODES } from '@nessie/executor-protocol'

import { ExecutorApiError } from '../src/api-client.js'
import { recordFailure } from '../src/folder-sync/engine-failures.js'
import { createSyncHarness } from './support/folder-sync-harness.js'

/**
 * A local move into another space's folder (docs/standards/folder-sync.md →
 * "Local moves"). Nessie refuses it in v1, so the engine never sends it: the
 * item goes back, the page keeps its space and stays writable, and one row
 * says the file cannot move between spaces — not that it is read-only.
 */

const harness = async (t: test.TestContext) => {
  const moves: string[] = []
  const h = await createSyncHarness({ wrap: (transport) => ({
    ...transport,
    move: (body) => { moves.push(body.pageId); return transport.move(body) },
  }) })
  t.after(h.cleanup)
  const marketing = h.server.actor.space('Marketing')
  return { h, marketing, moves }
}

test('a file moved into another space\'s folder goes back, and the row says why', async (t) => {
  const { h, marketing, moves } = await harness(t)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Plan', content: 'one\n' })
  h.server.actor.create({ spaceId: marketing.id, parentPageId: null, kind: 'document', title: 'Brief', content: 'b\n' })
  await h.enable()
  await h.settle()
  await rename(h.path('Projects/Plan.md'), h.path('Marketing/Plan.md'))
  await h.settle()
  assert.deepEqual(moves, [], 'the refused move is never sent')
  assert.equal(await h.read('Projects/Plan.md'), 'one\n')
  assert.equal(await h.readOrNull('Marketing/Plan.md'), null)
  assert.equal(h.server.pages.get(doc.id)!.spaceId, h.space.id)
  const rows = [...h.server.conflicts.values()]
  assert.deepEqual(rows.map((row) => [row.reason, row.kind, row.relPath]), [['moved_to_other_space', 'info', 'Projects/Plan.md']])
  // Still writable: an edit after the refusal is uploaded, not quarantined.
  await h.write('Projects/Plan.md', 'one\ntwo\n')
  await h.settle()
  assert.equal(h.server.text(h.server.pages.get(doc.id)), 'one\ntwo\n')
  assert.equal([...h.server.conflicts.values()].length, 1)
})

test('a folder moved into another space\'s folder goes back with everything in it; nothing is archived', async (t) => {
  const { h, moves } = await harness(t)
  const folder = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'folder', title: 'Specs' })
  const child = h.server.actor.create({ spaceId: h.space.id, parentPageId: folder.id, kind: 'document', title: 'API', content: 'a\n' })
  await h.enable()
  await h.settle()
  await mkdir(h.path('Marketing'), { recursive: true })
  await rename(h.path('Projects/Specs'), h.path('Marketing/Specs'))
  await h.settle()
  assert.deepEqual(moves, [])
  assert.equal(await h.read('Projects/Specs/API.md'), 'a\n')
  assert.equal(h.server.pages.get(child.id)!.status, h.server.pages.get(folder.id)!.status)
  assert.notEqual(h.server.pages.get(child.id)!.status, 'archived')
  assert.deepEqual([...h.server.conflicts.values()].map((row) => [row.reason, row.relPath]),
    [['moved_to_other_space', 'Projects/Specs']])
})

test('Nessie refusing a cross-space move does not make the page read-only', async () => {
  const page = { id: 'p1', readOnly: false, readOnlyReason: null }
  const pages = new Map([[page.id, page]])
  const refusal = new ExecutorApiError('Move a page to another space in Nessie.', {
    code: EXECUTOR_FOLDER_SYNC_ERROR_CODES.READ_ONLY, details: { reason: 'other_space' }, status: 403,
  })
  const outcome = await recordFailure({ pages, store: { entry: () => undefined }, now: () => 0 } as never,
    new Map(), { type: 'moveRemote' } as never, page.id, 'Marketing/Plan.md', refusal)
  assert.equal(outcome, 'replan')
  assert.equal(pages.get(page.id)!.readOnly, false)
})
