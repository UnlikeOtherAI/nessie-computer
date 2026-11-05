import assert from 'node:assert/strict'
import test from 'node:test'

import { createSyncHarness } from './support/folder-sync-harness.js'

/**
 * Found by the real-stack rehearsal (docs/testing/folder-sync-verification.md):
 * a held set must stay held, and say so, until a person decides — whatever
 * passes run in between. On the real daemon a pass woken by journal news scans
 * nothing, and the next one dropped the held set and called the folder up to
 * date while the space's files were gone from disk.
 */

const seedSpace = async () => {
  const h = await createSyncHarness()
  const other = h.server.actor.space('Handbook')
  for (let n = 0; n < 3; n += 1) {
    h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: `p${n}.txt`, content: `p ${n}` })
  }
  h.server.actor.create({ spaceId: other.id, parentPageId: null, kind: 'file', title: 'rules.txt', content: 'rules' })
  await h.enable()
  await h.settle()
  return h
}

test('a held space-folder delete stays held across a pass woken by journal news, and is not up to date', async (t) => {
  const h = await seedSpace()
  t.after(h.cleanup)
  await h.remove('Projects')
  await h.settle()
  const first = (await h.state()).heldDeletes
  assert.equal(first?.reason, 'space_folder_missing')
  assert.equal(first?.count, 3)
  assert.equal((await h.state()).state, 'needs_attention', 'held deletes wait for a person')

  // What the loop runs when the changes long-poll reports news: plan without walking.
  await h.pass({ scope: [] })
  await h.settle()
  const after = await h.state()
  assert.equal(after.heldDeletes?.batchId, first!.batchId, 'the same batch is still held')
  assert.equal(after.state, 'needs_attention')
  assert.ok([...h.server.pages.values()].every((page) => page.status === 'live'), 'nothing archived')

  // And a full reconcile later still holds it.
  await h.pass({ scope: null })
  await h.settle()
  assert.equal((await h.state()).heldDeletes?.batchId, first!.batchId)
})

test('Put the files back after a pass woken by news restores the space folder', async (t) => {
  const h = await seedSpace()
  t.after(h.cleanup)
  await h.remove('Projects')
  await h.settle()
  const held = (await h.state()).heldDeletes!
  await h.pass({ scope: [] })
  const { runConsoleCommand } = await import('../src/folder-sync/sync-command.js')
  assert.equal((await runConsoleCommand(h.context, { command: 'held_deletes', batchId: held.batchId, decision: 'restore' })).outcome, 'applied')
  await h.settle()
  for (let n = 0; n < 3; n += 1) assert.equal(await h.read(`Projects/p${n}.txt`), `p ${n}`)
  assert.equal((await h.state()).heldDeletes, null)
  assert.equal((await h.state()).state, 'up_to_date')
})
