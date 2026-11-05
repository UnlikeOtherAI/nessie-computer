import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import test from 'node:test'

import {
  editLocal, editRemote, effects, ofType, pageId, run, syncedWorld, updateRemote,
} from './folder-sync-fixtures.js'
import { createSyncHarness } from './support/folder-sync-harness.js'

for (const readOnly of [false, true]) {
  test(`a ${readOnly ? 'quarantined edit' : 'conflicted copy'} waits for its enclosing folder to move`, () => {
    const world = syncedWorld([
      { n: 1, title: 'docs', kind: 'folder' }, { n: 2, title: 'Notes', parent: 1, content: 'base' },
    ])
    editLocal(world, 'Space/docs/Notes.md', 'mine')
    editRemote(world, 2, 'theirs', 3)
    updateRemote(world, 1, { title: 'Work' })
    if (readOnly) updateRemote(world, 2, { readOnly: true, readOnlyReason: 'no_write_access' })
    const plan = run(world)
    assert.deepEqual(effects(plan), ['moveLocal'])
    assert.equal(ofType(plan, 'moveLocal')[0]!.pageId, pageId(1))
  })
}

test('a renamed folder with a dirty child that Nessie moved out converges and preserves both edits', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const folder = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'folder', title: 'docs' })
  const note = h.server.actor.create({
    spaceId: h.space.id, parentPageId: folder.id, kind: 'document', title: 'Notes', content: 'base',
  })
  await h.enable()
  await h.settle()
  await h.write('Projects/docs/Notes.md', 'mine')
  h.server.actor.rename(folder.id, 'Work')
  h.server.actor.move(note.id, null)
  h.server.actor.edit(note.id, 'theirs')
  await h.settle()
  assert.equal(await h.read('Projects/Notes.md'), 'theirs')
  const [row] = [...h.server.conflicts.values()]
  assert.ok(row?.copy)
  assert.equal(await h.read(row.copy.relPath), 'mine')
  assert.equal(h.server.text(h.server.pages.get(row.copy.pageId!)!), 'mine')
})

for (const folders of [false, true]) {
  test(`a three-way ${folders ? 'folder' : 'file'} rename rotates physical owners without changing their bytes`, async (t) => {
    const h = await createSyncHarness()
    t.after(h.cleanup)
    const names = folders ? ['A', 'B', 'C'] : ['A.bin', 'B.bin', 'C.bin']
    const pages = names.map((title) => h.server.actor.create({
      spaceId: h.space.id, parentPageId: null, kind: folders ? 'folder' : 'file', title, content: `bytes of ${title}`,
    }))
    if (folders) {
      for (const folder of pages) h.server.actor.create({
        spaceId: h.space.id, parentPageId: folder.id, kind: 'file', title: 'note.bin', content: `bytes of ${folder.title}`,
      })
    }
    await h.enable()
    await h.settle()
    if (folders) await h.write('Projects/A/new.bin', 'new while the folders move')
    for (const [n, page] of pages.entries()) h.server.actor.rename(page.id, names[(n + 1) % names.length]!)
    await h.settle()
    for (const [n, name] of names.entries()) {
      const target = names[(n + 1) % names.length]!
      assert.equal(await h.read(`Projects/${target}${folders ? '/note.bin' : ''}`), `bytes of ${name}`)
    }
    if (folders) {
      assert.equal(await h.read('Projects/B/new.bin'), 'new while the folders move')
      const created = [...h.server.pages.values()].find((page) => page.title === 'new.bin')
      assert.equal(created?.parentPageId, pages[0]!.id)
    }
    assert.deepEqual((await readdir(h.path('Projects'))).filter((name) => name.startsWith('.nessie-sync-')), [])
    assert.equal((await h.state()).state, 'up_to_date')
  })
}

for (const nested of [false, true]) {
  test(`a parent takes its child's old path when the folders are ${nested ? 'nested' : 'separate'} locally`, async (t) => {
    const h = await createSyncHarness()
    t.after(h.cleanup)
    const child = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'folder', title: 'docs' })
    const parent = h.server.actor.create({
      spaceId: h.space.id, parentPageId: nested ? child.id : null, kind: 'folder', title: 'docs',
    })
    h.server.actor.create({
      spaceId: h.space.id, parentPageId: child.id, kind: 'file', title: 'note.bin', content: 'kept bytes',
    })
    await h.enable()
    await h.settle()
    if (nested) h.server.actor.move(parent.id, null)
    h.server.actor.move(child.id, parent.id)
    await h.settle()
    assert.equal(await h.read('Projects/docs/docs/note.bin'), 'kept bytes')
    assert.deepEqual((await readdir(h.path('Projects'))).sort(), ['docs'])
    assert.equal(h.server.pages.size, 3)
    assert.equal((await h.state()).state, 'up_to_date')
  })
}

for (const renamedSortsFirst of [false, true]) {
  test(`a scoped pass orders colliding space renames (renamed space sorts ${renamedSortsFirst ? 'first' : 'last'})`, async (t) => {
    const h = await createSyncHarness()
    t.after(h.cleanup)
    const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002']
    h.space.id = ids[renamedSortsFirst ? 0 : 1]!
    const other = h.server.actor.space('Shared', { id: ids[renamedSortsFirst ? 1 : 0]! })
    for (const space of [h.space, other]) h.server.actor.create({
      spaceId: space.id, parentPageId: null, kind: 'file', title: 'note.bin', content: space.id,
    })
    await h.enable()
    await h.settle()
    await h.write('Projects/new.bin', 'not left behind')
    h.space.name = 'Shared'
    h.server.record({ spaceId: h.space.id, pageId: null, kind: 'space_updated', versionId: null, revision: null,
      parentPageId: null, title: null }, null)
    await h.pass({ scope: [] })
    await h.settle()
    const renamedDir = renamedSortsFirst ? 'Shared' : 'Shared (2)'
    const otherDir = renamedSortsFirst ? 'Shared (2)' : 'Shared'
    assert.equal(await h.read(renamedDir + '/note.bin'), h.space.id)
    assert.equal(await h.read(otherDir + '/note.bin'), other.id)
    assert.equal(await h.read(renamedDir + '/new.bin'), 'not left behind')
    assert.equal([...h.server.pages.values()].find((page) => page.title === 'new.bin')?.spaceId, h.space.id)
    assert.deepEqual((await readdir(h.teamDir())).filter((name) => !name.startsWith('.')), ['Shared', 'Shared (2)'])
  })
}


test('a two-folder name swap carries a conflicted child and a new local file to their owning folder', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const folders = ['A', 'B'].map((title) => h.server.actor.create({
    spaceId: h.space.id, parentPageId: null, kind: 'folder', title,
  }))
  const notes = folders.map((folder) => h.server.actor.create({
    spaceId: h.space.id, parentPageId: folder.id, kind: 'document', title: 'Notes', content: folder.title,
  }))
  await h.enable()
  await h.settle()
  await h.write('Projects/A/Notes.md', 'mine')
  await h.write('Projects/A/new.bin', 'new local file')
  h.server.actor.edit(notes[0]!.id, 'theirs')
  h.server.actor.rename(folders[0]!.id, 'B')
  h.server.actor.rename(folders[1]!.id, 'A')
  await h.settle()
  assert.equal(await h.read('Projects/B/Notes.md'), 'theirs')
  assert.equal(await h.read('Projects/A/Notes.md'), 'B')
  assert.equal(await h.read('Projects/B/new.bin'), 'new local file')
  const [row] = [...h.server.conflicts.values()]
  assert.ok(row?.copy)
  assert.equal(await h.read(row.copy.relPath), 'mine')
  assert.equal(h.server.pages.get(row.copy.pageId!)?.parentPageId, folders[0]!.id)
  assert.equal(h.server.pages.size, 6)
})
