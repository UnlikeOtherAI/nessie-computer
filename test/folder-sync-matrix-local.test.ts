import assert from 'node:assert/strict'
import { chmod, constants, mkdir, open, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { createMatrix, type Computer } from './support/folder-sync-sim/matrix-world.js'

/** The conflict matrix, C10–C23: what the folder and Nessie do to each other, case by case. */

const windows = process.platform === 'win32'
const reasons = (computer: Computer) => computer.openRows().map((row) => row.reason)
const quarantined = (names: readonly string[]) => names.filter((name) => name.includes('(your edit – not synced – '))

test('C10 rapid saves in Nessie collapse into one download of the newest head', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Live', content: '0\n' })
  await w.start()
  const before = w.pc.view.calls.filter((call) => call === 'download').length
  for (let n = 1; n <= 5; n += 1) w.server.actor.edit(doc.id, `${n}\n`)
  await w.pc.settle()
  assert.equal(await w.pc.read('Projects/Live.md'), '5\n')
  assert.equal(w.pc.view.calls.filter((call) => call === 'download').length - before, 1)
})

test('C11 an agent edits the document between the plan and the upload: the 409 replans and nothing is overwritten', async (t) => {
  let armed = false
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'file', title: 'race.bin', content: 'base' })
  w.hook.current = async (_who, operation) => {
    if (armed && operation === 'uploadFile') {
      armed = false
      w.server.actor.edit(doc.id, 'agent')
    }
  }
  await w.start()
  await w.pc.write('Projects/race.bin', 'person')
  armed = true
  await w.pc.settle()
  await w.pc.settle()
  assert.deepEqual(doc.versions.map((version) => Buffer.from(version.bytes).toString()), ['base', 'agent'])
  assert.equal(await w.pc.read('Projects/race.bin'), 'agent')
  const [copy] = await w.pc.copies('Projects')
  assert.equal(w.text(`Projects/${copy}`), 'person')
  assert.deepEqual(reasons(w.pc), ['edited_on_both_sides'])
  assert.deepEqual(w.server.audit.violations, [])
})

test('C12 a spreadsheet is a read-only mirror: a new snapshot in Nessie replaces the .xlsx', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const sheet = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'spreadsheet', title: 'Budget', content: 'xlsx v1' })
  await w.start()
  assert.equal(await w.pc.read('Projects/Budget.xlsx'), 'xlsx v1')
  w.server.actor.edit(sheet.id, 'xlsx v2')
  await w.pc.settle()
  assert.equal(await w.pc.read('Projects/Budget.xlsx'), 'xlsx v2')
  assert.equal((await w.pc.state()).state, 'up_to_date')
})

for (const subject of [
  { name: 'a published page', reason: 'read_only_published', file: 'Notice.md', create: { kind: 'document' as const, title: 'Notice', readOnlyReason: 'published' as const } },
  { name: 'a document Markdown cannot hold', reason: 'read_only_document_formatting', file: 'Rich.md', create: { kind: 'document' as const, title: 'Rich', lossy: true } },
  { name: 'a spreadsheet', reason: 'read_only_spreadsheet', file: 'Sheet.xlsx', create: { kind: 'spreadsheet' as const, title: 'Sheet' } },
]) {
  test(`C13 ${subject.name} edited here: the edit is kept beside it, never sent, and the mirror is restored (R1)`, async (t) => {
    const w = await createMatrix()
    t.after(w.cleanup)
    const page = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, ...subject.create, content: 'theirs\n' })
    await w.start()
    await chmod(w.pc.path(`Projects/${subject.file}`), 0o644)
    await w.pc.write(`Projects/${subject.file}`, 'mine\n')
    await w.pc.settle()
    assert.equal(page.versions.length, 1, 'nothing was sent')
    assert.equal(await w.pc.read(`Projects/${subject.file}`), 'theirs\n')
    const [kept] = quarantined(await w.pc.list('Projects'))
    assert.ok(kept, 'the edit is kept beside the file')
    assert.equal(await w.pc.read(`Projects/${kept}`), 'mine\n')
    assert.deepEqual(reasons(w.pc), [subject.reason])
    assert.equal(w.server.livePages().length, 1, 'a kept edit is local only: no page')
  })
}

test('C14 access to a space is revoked: its mirror goes to the trash, an unsent edit with it and flagged — even after a pass that did not walk it', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const shared = w.server.actor.space('Shared')
  w.server.actor.create({ spaceId: shared.id, parentPageId: null, kind: 'document', title: 'Secret', content: 's\n' })
  w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Mine', content: 'm\n' })
  await w.start()
  await w.pc.write('Shared/Secret.md', 's\nunsent\n')
  w.server.spaces.splice(w.server.spaces.indexOf(shared), 1)
  w.server.excludedSpaces.push({ spaceId: shared.id, reason: 'restricted_space' })
  w.server.record({ spaceId: shared.id, pageId: null, kind: 'access_changed', versionId: null, revision: null, parentPageId: null, title: null }, null)
  assert.equal((await w.pc.pass({ scope: ['Projects'] })).kind, 'ran')
  await w.pc.settle()
  assert.deepEqual(await w.pc.list('.'), ['Projects'])
  const trashed = (await w.pc.trash()).map((entry) => entry.relPath)
  assert.ok(trashed.includes('Shared'), 'the space\'s folder is in the trash, whole')
  assert.deepEqual(reasons(w.pc).sort(), ['access_removed', 'access_removed_edit_kept'])
  assert.equal(await w.pc.read('Projects/Mine.md'), 'm\n')
})

test('C15 a file too large for Nessie is an error entry with a row; it stays on disk and is never deleted', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  w.server.maxUploadBytes = 10
  await w.start()
  await w.pc.write('Projects/huge.bin', 'x'.repeat(64))
  await w.pc.settle()
  assert.equal(w.server.livePages().length, 0)
  assert.equal(await w.pc.read('Projects/huge.bin'), 'x'.repeat(64))
  assert.deepEqual(reasons(w.pc), ['too_large'])
  assert.notEqual((await w.pc.state()).state, 'up_to_date')
})

test('C16 a zero-byte file syncs both ways', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'file', title: 'empty-there.txt', content: '' })
  await w.start()
  assert.equal(await w.pc.read('Projects/empty-there.txt'), '')
  await w.pc.write('Projects/empty-here.txt', '')
  await w.pc.settle()
  assert.equal(w.text('Projects/empty-here.txt'), '')
  assert.equal((await w.pc.state()).state, 'up_to_date')
})

test('C17 a link in the folder is never followed nor sent; one row says so', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Here', content: 'h\n' })
  await w.start()
  const outside = join(w.pc.replica.tmp, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'private.txt'), 'not for Nessie')
  await symlink(outside, w.pc.path('Projects/linked'), windows ? 'junction' : 'dir')
  await w.pc.settle()
  await w.pc.settle()
  assert.equal(w.server.livePages().length, 1, 'nothing behind the link was sent')
  assert.deepEqual(reasons(w.pc), ['link_not_synced'])
})

test('C18 a file held open on Windows waits, then lands once released', { skip: !windows && 'Windows share modes' }, async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'file', title: 'held.docx', content: 'v1' })
  await w.start()
  w.server.actor.edit(doc.id, 'v2')
  const held = await open(w.pc.path('Projects/held.docx'), constants.O_RDWR | 0x1000_0000)
  try {
    for (let n = 0; n < 3; n += 1) assert.equal((await w.pc.pass()).kind, 'ran')
    assert.equal(await w.pc.read('Projects/held.docx').catch(() => 'held'), 'held')
    assert.notEqual((await w.pc.state()).state, 'up_to_date')
  } finally {
    await held.close()
  }
  w.advance(10 * 60 * 1000)
  await w.pc.settle()
  assert.equal(await w.pc.read('Projects/held.docx'), 'v2')
})

test('C19 a full disk pauses downloads (disk_full) and recovers once there is room', async (t) => {
  let full = true
  const w = await createMatrix()
  t.after(w.cleanup)
  w.hook.current = async (_who, operation) => {
    if (full && operation === 'download') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  }
  w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Big', content: 'b\n' })
  await w.pc.enable()
  await w.pc.pass()
  assert.equal((await w.pc.state()).state, 'disk_full')
  assert.equal(await w.pc.readOrNull('Projects/Big.md'), null)
  full = false
  await w.pc.settle()
  assert.equal(await w.pc.read('Projects/Big.md'), 'b\n')
  assert.equal((await w.pc.state()).state, 'up_to_date')
})

test('C20 reserved, illegal, case-colliding, NFC/NFD and over-long titles all map to valid, distinct names, and edits go back', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const titles = ['CON', 'a:b', 'Trailing.', 'Report', 'report', 'Café', 'Café', 'L'.repeat(300)]
  const pages = titles.map((title) => w.server.actor.create({
    spaceId: w.space.id, parentPageId: null, kind: 'document', title, content: `${title.slice(0, 8)}\n`,
  }))
  await w.start()
  const names = (await w.pc.list('Projects')).sort()
  assert.equal(names.length, titles.length, 'one file per page, none dropped')
  for (const name of ['_CON.md', 'a_b.md', 'Trailing.md', 'Report.md', 'report (2).md', 'Café.md', 'Café (2).md']) {
    assert.ok(names.includes(name), `${name} is on disk`)
  }
  const long = names.find((name) => name.startsWith('LLLL'))!
  assert.match(long, /~[0-9a-f]{6}\.md$/u)
  assert.ok(Buffer.byteLength(long) <= 200)
  await w.pc.write('Projects/_CON.md', 'CON\nedited\n')
  await w.pc.settle()
  assert.equal(w.server.text(pages[0]), 'CON\nedited\n')
  assert.equal((await w.pc.state()).state, 'up_to_date')
})

test('C21 deleting the whole sync folder is root_missing: nothing is archived in Nessie', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Safe', content: 's\n' })
  await w.start()
  await rm(w.pc.replica.root, { recursive: true, force: true })
  await w.pc.settle()
  assert.equal(doc.status, 'live')
  assert.ok(!w.pc.view.calls.includes('archive'))
  assert.equal((await w.pc.state()).state, 'root_missing')
})

test('C22 pointing sync at a folder that already has files asks first; accepted, they become pages', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  await mkdir(join(w.pc.replica.root, 'UnlikeOtherAI', 'Projects'), { recursive: true })
  await writeFile(join(w.pc.replica.root, 'UnlikeOtherAI', 'Projects', 'old notes.txt'), 'from before')
  const asked = await w.pc.command({ command: 'configure', root: w.pc.replica.root, enabled: true, acceptExistingFiles: false })
  assert.deepEqual(asked, { outcome: 'confirm_existing_files', fileCount: 1 })
  assert.equal(w.server.livePages().length, 0)
  await w.pc.command({ command: 'configure', root: w.pc.replica.root, enabled: true, acceptExistingFiles: true })
  await w.pc.settle()
  assert.equal(w.text('Projects/old notes.txt'), 'from before')
})

test('C23 a mass delete is held; Restore brings every file back and Nessie archives nothing', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const pages = Array.from({ length: 12 }, (_, n) => w.server.actor.create({
    spaceId: w.space.id, parentPageId: null, kind: 'file', title: `f${n}.txt`, content: `file ${n}`,
  }))
  await w.start()
  for (const name of await readdir(w.pc.path('Projects'))) await w.pc.remove(`Projects/${name}`)
  await w.pc.settle()
  const held = (await w.pc.state()).heldDeletes
  assert.equal(held?.count, 12)
  assert.ok(pages.every((page) => page.status === 'live'))
  await w.pc.command({ command: 'held_deletes', batchId: held!.batchId, decision: 'restore' })
  await w.pc.settle()
  assert.equal((await w.pc.list('Projects')).length, 12)
  assert.ok(pages.every((page) => page.status === 'live'))
  assert.equal((await w.pc.state()).heldDeletes, null)
  assert.ok((await stat(w.pc.path('Projects/f0.txt'))).isFile())
})
