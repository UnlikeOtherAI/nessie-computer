import assert from 'node:assert/strict'
import { rename, stat, utimes, writeFile } from 'node:fs/promises'
import test from 'node:test'

import { createMatrix, type Computer } from './support/folder-sync-sim/matrix-world.js'

/**
 * The conflict matrix (plan §3, C1–C9 and C24), each case through the whole
 * engine — a real folder, the signed transport, the fake Nessie — asserting
 * what a person sees: the files on disk, the pages and versions in Nessie,
 * the conflict row's reason, and the honest state. Later cases are in the
 * other `folder-sync-matrix-*.test.ts` files.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const reasons = (computer: Computer) => computer.openRows().map((row) => row.reason)

test('C1 two people edit one document at once, overlapping: Nessie keeps the path, the edit is a copy on disk and a sibling page, one row', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Plan', content: 'a\nb\nc\n' })
  await w.start()
  w.server.actor.edit(doc.id, 'a\nB from Nessie\nc\n')
  await w.pc.write('Projects/Plan.md', 'a\nB from here\nc\n')
  await w.pc.settle()
  await w.pc.settle()
  assert.equal(await w.pc.read('Projects/Plan.md'), 'a\nB from Nessie\nc\n')
  const [copy, ...more] = await w.pc.copies('Projects')
  assert.ok(copy)
  assert.deepEqual(more, [])
  assert.equal(await w.pc.read(`Projects/${copy}`), 'a\nB from here\nc\n')
  assert.equal(w.text(`Projects/${copy.replace(/\.md$/u, '')}`), 'a\nB from here\nc\n', 'the copy is a sibling page')
  assert.equal(w.server.pages.get(doc.id)!.versions.length, 2, 'nothing was written over Nessie\'s version')
  assert.deepEqual(reasons(w.pc), ['edited_on_both_sides'])
  assert.equal((await w.pc.state()).state, 'needs_attention')
  assert.deepEqual(w.server.audit.violations, [])
})

test('C1 two people edit one document at once, apart: one clean merge, one new version, no conflict (R3)', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'List', content: 'a\nb\nc\nd\n' })
  await w.start()
  w.server.actor.edit(doc.id, 'A\nb\nc\nd\n')
  await w.pc.write('Projects/List.md', 'a\nb\nc\nD\n')
  await w.pc.settle()
  assert.equal(await w.pc.read('Projects/List.md'), 'A\nb\nc\nD\n')
  assert.equal(w.server.text(doc), 'A\nb\nc\nD\n')
  assert.equal(doc.versions.length, 3, 'base, Nessie\'s edit, and one merged version')
  assert.deepEqual(await w.pc.copies('Projects'), [])
  assert.deepEqual(w.pc.rows(), [])
  assert.equal((await w.pc.state()).state, 'up_to_date')
})

test('C1 a person here and an agent in Nessie edit one file at once: binary content keeps both (R2)', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const file = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'file', title: 'deck.bin', content: 'v1' })
  await w.start()
  w.server.actor.edit(file.id, 'agent v2')
  await w.pc.write('Projects/deck.bin', 'person v2')
  await w.pc.settle()
  await w.pc.settle()
  assert.equal(await w.pc.read('Projects/deck.bin'), 'agent v2')
  const [copy] = await w.pc.copies('Projects')
  assert.equal(await w.pc.read(`Projects/${copy}`), 'person v2')
  assert.equal(w.text(`Projects/${copy}`), 'person v2')
  assert.deepEqual(reasons(w.pc), ['edited_on_both_sides'])
})

test('C2 edited here, deleted in Nessie: the edit becomes a new page at the same path; the old page stays archived (R4)', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Memo', content: 'one\n' })
  await w.start()
  w.server.actor.archive(doc.id)
  await w.pc.write('Projects/Memo.md', 'one\nmine\n')
  await w.pc.settle()
  assert.equal(doc.status, 'archived')
  assert.equal(doc.versions.length, 1, 'the archived page\'s history is untouched')
  const recreated = w.page('Projects/Memo')
  assert.ok(recreated && recreated.id !== doc.id)
  assert.equal(w.server.text(recreated), 'one\nmine\n')
  assert.equal(await w.pc.read('Projects/Memo.md'), 'one\nmine\n')
  assert.deepEqual(reasons(w.pc), ['deleted_in_nessie_edit_kept'])
})

test('C3 edited in Nessie, deleted here: the head comes back and the delete is not sent (R4)', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Keep', content: 'one\n' })
  await w.start()
  w.server.actor.edit(doc.id, 'one\ntwo\n')
  await w.pc.remove('Projects/Keep.md')
  await w.pc.settle()
  assert.equal(doc.status, 'live')
  assert.equal(await w.pc.read('Projects/Keep.md'), 'one\ntwo\n')
  assert.deepEqual(reasons(w.pc), ['deleted_here_restored'])
})

test('C4 renamed differently on both sides: the file takes Nessie\'s name and the row says so (R6)', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Draft', content: 'x\n' })
  await w.start()
  await w.pc.rename('Projects/Draft.md', 'Projects/Mine.md')
  w.server.actor.rename(doc.id, 'Theirs')
  await w.pc.settle()
  assert.equal(doc.title, 'Theirs')
  assert.deepEqual((await w.pc.list('Projects')).sort(), ['Theirs.md'])
  assert.equal(await w.pc.read('Projects/Theirs.md'), 'x\n')
  assert.deepEqual(reasons(w.pc), ['renamed_in_nessie'])
})

test('C5a folder deleted here while a child was edited in Nessie: the folder and that child come back; the untouched sibling is archived', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const folder = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'folder', title: 'Trip' })
  const edited = w.server.actor.create({ spaceId: w.space.id, parentPageId: folder.id, kind: 'document', title: 'Plan', content: 'p\n' })
  const quiet = w.server.actor.create({ spaceId: w.space.id, parentPageId: folder.id, kind: 'document', title: 'Old', content: 'o\n' })
  await w.start()
  w.server.actor.edit(edited.id, 'p\nnew\n')
  await w.pc.remove('Projects/Trip')
  await w.pc.settle()
  await w.pc.settle()
  assert.equal(folder.status, 'live')
  assert.equal(edited.status, 'live')
  assert.equal(await w.pc.read('Projects/Trip/Plan.md'), 'p\nnew\n')
  assert.equal(quiet.status, 'archived', 'only the untouched child follows the delete')
  assert.equal(await w.pc.readOrNull('Projects/Trip/Old.md'), null)
  assert.ok(reasons(w.pc).includes('folder_deleted_here_child_restored'))
})

test('C5b a child edited here while its folder was deleted in Nessie: the folder and child are recreated as new pages; siblings stay archived', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const folder = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'folder', title: 'Trip' })
  w.server.actor.create({ spaceId: w.space.id, parentPageId: folder.id, kind: 'document', title: 'Plan', content: 'p\n' })
  const sibling = w.server.actor.create({ spaceId: w.space.id, parentPageId: folder.id, kind: 'document', title: 'Old', content: 'o\n' })
  await w.start()
  w.server.actor.archive(folder.id)
  await w.pc.write('Projects/Trip/Plan.md', 'p\nmine\n')
  await w.pc.settle()
  const recreated = w.page('Projects/Trip')
  assert.ok(recreated && recreated.id !== folder.id)
  assert.equal(w.text('Projects/Trip/Plan'), 'p\nmine\n')
  assert.equal(sibling.status, 'archived')
  assert.equal(await w.pc.readOrNull('Projects/Trip/Old.md'), null, 'the untouched sibling left the disk with its folder')
  assert.deepEqual(reasons(w.pc), ['folder_deleted_in_nessie_child_recreated'])
})

test('C5b on two computers: the second adopts the folder the first recreated — one folder, never a twin', async (t) => {
  const w = await createMatrix({ computers: 2 })
  t.after(w.cleanup)
  const [laptop, desktop] = w.computers as [Computer, Computer]
  const folder = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'folder', title: 'Trip' })
  w.server.actor.create({ spaceId: w.space.id, parentPageId: folder.id, kind: 'document', title: 'A', content: 'a\n' })
  w.server.actor.create({ spaceId: w.space.id, parentPageId: folder.id, kind: 'document', title: 'B', content: 'b\n' })
  await w.start()
  w.server.actor.archive(folder.id)
  await laptop.write('Projects/Trip/A.md', 'a\nlaptop\n')
  await desktop.write('Projects/Trip/B.md', 'b\ndesktop\n')
  await w.settleAll()
  const trips = w.server.livePages().filter((page) => page.kind === 'folder')
  assert.equal(trips.length, 1, 'one Trip folder in Nessie')
  for (const computer of w.computers) {
    assert.deepEqual((await computer.list('Projects')).sort(), ['Trip'])
    assert.equal(await computer.read('Projects/Trip/A.md'), 'a\nlaptop\n')
    assert.equal(await computer.read('Projects/Trip/B.md'), 'b\ndesktop\n')
  }
})

test('C6 created on both sides with identical bytes: adopted, nothing uploaded', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  await w.start()
  w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'file', title: 'same.txt', content: 'twin' })
  await w.pc.write('Projects/same.txt', 'twin')
  await w.pc.settle()
  assert.equal(w.server.livePages().length, 1)
  assert.ok(!w.pc.view.calls.includes('upload_complete'))
  assert.deepEqual(w.pc.rows(), [])
  assert.equal((await w.pc.state()).state, 'up_to_date')
})

test('C6 created on both sides with different bytes: Nessie keeps the name, ours is a copy and a page (R2)', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  await w.start()
  w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'file', title: 'idea.txt', content: 'theirs' })
  await w.pc.write('Projects/idea.txt', 'mine')
  await w.pc.settle()
  await w.pc.settle()
  assert.equal(await w.pc.read('Projects/idea.txt'), 'theirs')
  const [copy] = await w.pc.copies('Projects')
  assert.equal(await w.pc.read(`Projects/${copy}`), 'mine')
  assert.equal(w.text(`Projects/${copy}`), 'mine')
  assert.deepEqual(reasons(w.pc), ['created_on_both_sides'])
})

test('C7 a file in Nessie where a folder is here: the folder moves to " (2)" and both sync', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  await w.start()
  await w.pc.write('Projects/Docs/inside.txt', 'kept')
  w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'file', title: 'Docs', content: 'a file' })
  await w.pc.settle()
  await w.pc.settle()
  assert.equal(await w.pc.read('Projects/Docs'), 'a file')
  assert.equal(await w.pc.read('Projects/Docs (2)/inside.txt'), 'kept')
  assert.equal(w.text('Projects/Docs (2)/inside.txt'), 'kept')
  assert.ok(w.pc.rows().some((row) => row.reason === 'type_changed'))
})

test('C8 offline edits meet remote edits: the journal is replayed first, then the edit is planned against it', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Trip', content: 'day 1\n' })
  const gone = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Gone', content: 'g\n' })
  await w.start()
  w.pc.view.offline = true
  await w.pc.write('Projects/Trip.md', 'day 1 here\n')
  await w.pc.write('Projects/Gone.md', 'g\nmine\n')
  assert.equal((await w.pc.pass()).kind, 'failed')
  assert.equal((await w.pc.state()).state, 'offline')
  w.server.actor.edit(doc.id, 'day 1 in Nessie\n')
  w.server.actor.archive(gone.id)
  w.pc.view.offline = false
  await w.pc.settle()
  await w.pc.settle()
  assert.equal(await w.pc.read('Projects/Trip.md'), 'day 1 in Nessie\n')
  assert.equal(w.text('Projects/Gone'), 'g\nmine\n')
  assert.deepEqual(reasons(w.pc).sort(), ['deleted_in_nessie_edit_kept', 'edited_on_both_sides'])
})

test('C9 a computer whose clock is a day off still syncs: decisions use hashes and versions, never time', async (t) => {
  for (const skew of [DAY_MS, -DAY_MS]) {
    const w = await createMatrix({ computers: 2, skewMs: [skew, 0] })
    t.after(w.cleanup)
    const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Clock', content: 'a\nb\n' })
    await w.start()
    const [skewed, right] = w.computers as [Computer, Computer]
    await skewed.write('Projects/Clock.md', 'A\nb\n')
    await w.settleAll()
    await right.write('Projects/Clock.md', 'A\nB\n')
    await w.settleAll()
    assert.equal(w.server.text(doc), 'A\nB\n')
    assert.equal(await skewed.read('Projects/Clock.md'), 'A\nB\n')
    assert.deepEqual(w.server.audit.violations, [])
  }
})

test('C9/T05 a save that keeps the size and the modification time is still found: a new file id is hashed', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Same', content: 'aaaa\n' })
  await w.start()
  const before = await stat(w.pc.path('Projects/Same.md'))
  const staged = `${w.pc.path('Projects/Same.md')}.sb-1`
  await writeFile(staged, 'bbbb\n')
  await utimes(staged, before.atime, before.mtime)
  await rename(staged, w.pc.path('Projects/Same.md'))
  await w.pc.settle()
  assert.equal(w.server.text(doc), 'bbbb\n')
})

test('C24 two computers both edit one file offline: whoever reconnects second gets the conflicted copy', async (t) => {
  const w = await createMatrix({ computers: 2 })
  t.after(w.cleanup)
  const [laptop, desktop] = w.computers as [Computer, Computer]
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Trip', content: 'one\n' })
  await w.start()
  laptop.view.offline = true
  desktop.view.offline = true
  await laptop.write('Projects/Trip.md', 'laptop\n')
  await desktop.write('Projects/Trip.md', 'desktop\n')
  laptop.view.offline = false
  await laptop.settle()
  desktop.view.offline = false
  await w.settleAll()
  assert.equal(w.server.text(doc), 'laptop\n', 'first committed wins')
  assert.deepEqual(await laptop.copies('Projects'), [])
  const [copy] = await desktop.copies('Projects')
  assert.equal(await desktop.read(`Projects/${copy}`), 'desktop\n')
  assert.equal(await laptop.read(`Projects/${copy}`), 'desktop\n', 'the copy is a page, so it reaches the other computer')
  assert.deepEqual(reasons(desktop), ['edited_on_both_sides'])
  assert.deepEqual(reasons(laptop), [])
})
