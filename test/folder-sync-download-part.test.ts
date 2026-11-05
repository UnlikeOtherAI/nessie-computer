import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { folderSyncPaths } from '../src/folder-sync/state-files.js'
import { createSyncHarness } from './support/folder-sync-harness.js'

/**
 * Found by the real-stack rehearsal: an install refused after its fetch (A8)
 * leaves a complete `.part`. The next attempt asked for `bytes=<length>-`; the
 * real route answers that with a bodiless 416, which the engine read as a
 * transient failure — every later pass failed and the whole folder stopped
 * syncing, backing off to five minutes.
 */

const partOf = (h: Awaited<ReturnType<typeof createSyncHarness>>, pageId: string, versionId: string) =>
  join(folderSyncPaths(h.stateDir).pending, `${pageId}.${versionId}.part`)

test('a complete .part left from an earlier attempt is installed without asking for a range past the end', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'notes.txt', content: 'one\n' })
  const other = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'other.txt', content: 'a\n' })
  await h.enable()
  await h.settle()
  h.server.actor.edit(doc.id, 'one\ntwo\n')
  h.server.actor.edit(other.id, 'a\nb\n')
  const head = h.server.head(h.server.pages.get(doc.id)!)!
  await writeFile(partOf(h, doc.id, head.versionId), head.bytes)
  await h.settle()
  assert.equal(await h.read('Projects/notes.txt'), 'one\ntwo\n')
  assert.equal(await h.read('Projects/other.txt'), 'a\nb\n', 'the rest of the folder keeps syncing')
  assert.equal((await h.state()).state, 'up_to_date')
})

test('a .part longer than its version starts over, and a wrong complete one is fetched again', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const long = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'long.txt', content: 'x\n' })
  const wrong = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'wrong.txt', content: 'y\n' })
  await h.enable()
  await h.settle()
  h.server.actor.edit(long.id, 'xx\n')
  h.server.actor.edit(wrong.id, 'yy\n')
  const longHead = h.server.head(h.server.pages.get(long.id)!)!
  const wrongHead = h.server.head(h.server.pages.get(wrong.id)!)!
  await writeFile(partOf(h, long.id, longHead.versionId), 'far too many bytes\n')
  await writeFile(partOf(h, wrong.id, wrongHead.versionId), 'zz\n')
  await h.settle()
  assert.equal(await h.read('Projects/long.txt'), 'xx\n')
  assert.equal(await h.read('Projects/wrong.txt'), 'yy\n')
})
