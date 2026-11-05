import assert from 'node:assert/strict'
import test from 'node:test'

import { createMatrix } from './support/folder-sync-sim/matrix-world.js'

test('a child edited after the pull wins over a folder delete sent moments later', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const folder = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'folder', title: 'Folder' })
  const child = w.server.actor.create({ spaceId: w.space.id, parentPageId: folder.id,
    kind: 'file', title: 'notes.txt', content: 'before\n' })
  await w.start()
  await w.pc.remove('Projects/Folder')
  let raced = false
  w.hook.current = async (_replica, operation, pageId) => {
    if (operation !== 'archive' || pageId !== folder.id || raced) return
    raced = true
    w.server.actor.edit(child.id, 'saved after the pull\n')
  }
  await w.pc.settle()
  assert.ok(raced)
  assert.equal(folder.status, 'live')
  assert.equal(child.status, 'live')
  assert.equal(await w.pc.read('Projects/Folder/notes.txt'), 'saved after the pull\n')
  assert.deepEqual(w.server.audit.violations, [])
})
