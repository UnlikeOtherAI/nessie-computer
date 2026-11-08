import assert from 'node:assert/strict'
import { readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { folderSyncPaths } from '../src/folder-sync/state-files.js'
import { listTrash } from '../src/folder-sync/trash-book.js'
import { createSyncHarness } from './support/folder-sync-harness.js'

test('initial sync brings every page down, byte-correct, and settles up to date', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const plans = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'folder', title: 'Plans' })
  h.server.actor.create({ spaceId: h.space.id, parentPageId: plans.id, kind: 'document', title: 'Roadmap', content: '# Roadmap\n' })
  h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'logo.png', content: new Uint8Array([1, 2, 3]) })
  assert.equal((await h.enable()).outcome, 'applied')
  await h.settle()
  assert.equal(await h.read('Projects/Plans/Roadmap.md'), '# Roadmap\n')
  assert.deepEqual([...await import('node:fs/promises').then((fs) => fs.readFile(h.path('Projects/logo.png')))], [1, 2, 3])
  const state = await h.state()
  assert.equal(state.state, 'up_to_date')
  assert.equal(state.counts.entries, 3)
  assert.equal(state.teamLabel, 'UnlikeOtherAI/Platform')
})

test('ongoing edits converge both ways', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Notes', content: 'one\n' })
  await h.enable()
  await h.settle()
  h.server.actor.edit(doc.id, 'one\ntwo\n')
  await h.settle()
  assert.equal(await h.read('Projects/Notes.md'), 'one\ntwo\n')
  await h.write('Projects/Notes.md', 'one\ntwo\nthree\n')
  await h.settle()
  assert.equal(h.server.text(h.server.pages.get(doc.id)), 'one\ntwo\nthree\n')
  await h.write('Projects/New idea.txt', 'fresh')
  await h.settle()
  const created = h.server.find('Projects/New idea.txt')
  assert.equal(h.server.text(created), 'fresh')
  assert.equal((await h.state()).state, 'up_to_date')
})

test('a local rename is a move in Nessie; a delete archives the page and keeps a trash copy', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Draft', content: 'text\n' })
  const other = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'old.txt', content: 'bye' })
  await h.enable()
  await h.settle()
  await rename(h.path('Projects/Draft.md'), h.path('Projects/Final.md'))
  await h.remove('Projects/old.txt')
  await h.settle()
  assert.equal(h.server.pages.get(doc.id)!.title, 'Final')
  assert.equal(h.server.pages.get(other.id)!.status, 'archived')
  const trash = folderSyncPaths(h.stateDir)
  assert.deepEqual(await listTrash(trash), [], 'a local delete needs no trash copy: the person deleted the file themselves')
  h.server.actor.archive(doc.id)
  await h.settle()
  assert.equal(await h.readOrNull('Projects/Final.md'), null)
  const [entry] = await listTrash(trash)
  assert.equal(entry?.relPath, 'Projects/Final.md')
  assert.ok((await readdir(join(h.stateDir, 'folder-sync', 'trash'))).some((name) => /^\d{4}-\d{2}-\d{2}$/u.test(name)))
})

const conflictCopyOf = async (h: Awaited<ReturnType<typeof createSyncHarness>>, dir: string) =>
  (await readdir(h.path(dir))).filter((name) => name.includes('(conflicted copy – Laptop – '))

test('a simultaneous edit keeps both: Nessie keeps the path, the copy is on disk and is a page, one row', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Plan', content: 'a\nb\nc\n' })
  await h.enable()
  await h.settle()
  h.server.actor.edit(doc.id, 'a\nB from Nessie\nc\n')
  await h.write('Projects/Plan.md', 'a\nB from here\nc\n')
  await h.settle()
  assert.equal(await h.read('Projects/Plan.md'), 'a\nB from Nessie\nc\n')
  const [copy] = await conflictCopyOf(h, 'Projects')
  assert.ok(copy, 'the conflicted copy is on disk')
  assert.equal(await h.read(`Projects/${copy}`), 'a\nB from here\nc\n')
  const copyPage = h.server.find(`Projects/${copy!.replace(/\.md$/u, '')}`)
  assert.equal(h.server.text(copyPage), 'a\nB from here\nc\n', 'the copy is a sibling page in Nessie')
  const rows = [...h.server.conflicts.values()]
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.reason, 'edited_on_both_sides')
  assert.equal(rows[0]!.copy?.pageId, copyPage!.id)
  assert.equal(rows[0]!.headVersionId, h.server.head(h.server.pages.get(doc.id)!)!.versionId)
  const state = await h.state()
  assert.equal(state.state, 'needs_attention')
  assert.equal(state.conflicts.length, 1)
})

test('the copy and the change comment carry the computer\'s label from Nessie, not the host name', async (t) => {
  const comments: string[] = []
  const h = await createSyncHarness({ wrap: (transport) => ({
    ...transport,
    writeDocument: (body) => { comments.push(body.changeComment); return transport.writeDocument(body) },
  }) })
  t.after(h.cleanup)
  // Two computers on one host differ only by the label Nessie shows.
  h.server.computerLabel = 'Ondrej\'s PC: work'
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Plan', content: 'a\nb\nc\n' })
  await h.enable()
  await h.settle()
  await h.write('Projects/Plan.md', 'a\nb\nc\nd\n')
  await h.settle()
  assert.deepEqual(comments, ['Synced from Ondrej\'s PC: work'])
  h.server.actor.edit(doc.id, 'a\nB from Nessie\nc\nd\n')
  await h.write('Projects/Plan.md', 'a\nB from here\nc\nd\n')
  await h.settle()
  const copies = (await readdir(h.path('Projects'))).filter((name) => name.includes('(conflicted copy – '))
  assert.equal(copies.length, 1)
  assert.match(copies[0]!, /^Plan \(conflicted copy – Ondrej's PC_ work – \d{4}-\d{2}-\d{2} \d{4}\)\.md$/u)
})

test('non-overlapping edits on both sides merge cleanly into one version, with no conflict', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'List', content: 'a\nb\nc\nd\ne\n' })
  await h.enable()
  await h.settle()
  h.server.actor.edit(doc.id, 'A\nb\nc\nd\ne\n')
  await h.write('Projects/List.md', 'a\nb\nc\nd\nE\n')
  await h.settle()
  assert.equal(await h.read('Projects/List.md'), 'A\nb\nc\nd\nE\n')
  assert.equal(h.server.text(h.server.pages.get(doc.id)), 'A\nb\nc\nd\nE\n')
  assert.equal(h.server.conflicts.size, 0)
  assert.deepEqual(await conflictCopyOf(h, 'Projects'), [])
  assert.equal((await h.state()).state, 'up_to_date')
})

test('a mass delete is held until a person confirms it; nothing is archived before', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const pages = Array.from({ length: 12 }, (_, n) => h.server.actor.create({
    spaceId: h.space.id, parentPageId: null, kind: 'file', title: `f${n}.txt`, content: `file ${n}`,
  }))
  await h.enable()
  await h.settle()
  for (let n = 0; n < 12; n += 1) await h.remove(`Projects/f${n}.txt`)
  await h.settle()
  assert.ok(pages.every((page) => page.status === 'live'), 'nothing archived while held')
  const held = (await h.state()).heldDeletes
  assert.equal(held?.count, 12)
  assert.equal(held?.reason, 'mass_delete')
  assert.equal(h.server.reports.at(-1)?.heldDeletes?.batchId, held!.batchId)
  const { runConsoleCommand } = await import('../src/folder-sync/sync-command.js')
  assert.equal((await runConsoleCommand(h.context, { command: 'held_deletes', batchId: held!.batchId, decision: 'confirm' })).outcome, 'applied')
  await h.settle()
  assert.ok(pages.every((page) => page.status === 'archived'))
  assert.equal((await h.state()).heldDeletes, null)
})

test('edits made offline queue up and replay once Nessie answers again', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Trip', content: 'day 1\n' })
  await h.enable()
  await h.settle()
  h.server.offline = true
  await h.write('Projects/Trip.md', 'day 1\nday 2\n')
  await h.write('Projects/Packing.txt', 'socks')
  await assert.rejects(h.pass())
  assert.equal((await h.state()).state, 'offline')
  h.server.offline = false
  await h.settle()
  assert.equal(h.server.text(h.server.pages.get(doc.id)), 'day 1\nday 2\n')
  assert.equal(h.server.text(h.server.find('Projects/Packing.txt')), 'socks')
})

test('our own writes come back as journal rows and are never downloaded again (echo suppression)', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Echo', content: 'x\n' })
  await h.enable()
  await h.settle()
  const downloads = () => h.server.calls.filter((call) => call === 'download').length
  const before = downloads()
  await h.write('Projects/Echo.md', 'x\ny\n')
  await h.settle()
  await h.settle()
  assert.equal(downloads(), before, 'the row our upload made is recognised as ours')
  assert.ok(h.server.journal.some((row) => row.actorExecutorId === h.server.executorId && row.kind === 'version_created'))
})

test('without any watcher, the periodic full reconcile still finds a local edit', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Quiet', content: 'q\n' })
  await h.enable()
  await h.settle()
  await h.write('Projects/Quiet.md', 'q\nchanged without an event\n')
  await h.pass({ scope: [] })
  await h.pass({ scope: [] })
  assert.equal(h.server.text(h.server.pages.get(doc.id)), 'q\n', 'a remote-only wake walks nothing')
  await h.settle()
  assert.equal(h.server.text(h.server.pages.get(doc.id)), 'q\nchanged without an event\n')
})

const FAULTS = [
  { name: 'the copy page was created but its answer was lost', operation: 'create_page', mode: 'lose_answer' as const },
  { name: 'Nessie was unreachable right after the local copy', operation: 'create_page', mode: 'refuse' as const },
  { name: 'the first download of the pass failed', operation: 'download', mode: 'refuse' as const },
  { name: 'the first download of the pass was served but its answer was lost', operation: 'download', mode: 'lose_answer' as const },
]
const KINDS = [
  { kind: 'document' as const, title: 'Ledger', file: 'Ledger.md', create: 'create_page' },
  { kind: 'file' as const, title: 'blob.bin', file: 'blob.bin', create: 'upload_complete' },
]

for (const subject of KINDS) {
  for (const fault of FAULTS) {
    test(`keep-both of a ${subject.kind} survives a crash when ${fault.name}: the journal resumes the chain`, async (t) => {
      const h = await createSyncHarness()
      t.after(h.cleanup)
      const page = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: subject.kind, title: subject.title, content: 'base\n' })
      await h.enable()
      await h.settle()
      h.server.actor.edit(page.id, 'theirs\n')
      await h.write(`Projects/${subject.file}`, 'mine\n')
      const operation = fault.operation === 'create_page' ? subject.create : fault.operation
      h.server.faults.push(fault.mode === 'refuse'
        ? { operation, mode: 'refuse', status: 503, code: 'EXECUTOR_FOLDER_SYNC_UNAVAILABLE' }
        : { operation, mode: 'lose_answer' })
      let crashed = false
      for (let pass = 0; pass < 4 && !crashed; pass += 1) crashed = await h.pass().then(() => false, () => true)
      assert.ok(crashed, 'the injected failure ended a pass')
      h.restart()
      await h.settle()
      assert.equal(await h.read(`Projects/${subject.file}`), 'theirs\n')
      const copies = await conflictCopyOf(h, 'Projects')
      assert.equal(copies.length, 1)
      assert.equal(await h.read(`Projects/${copies[0]}`), 'mine\n')
      const copyPages = h.server.livePages().filter((candidate) => candidate.title.includes('(conflicted copy'))
      assert.equal(copyPages.length, 1, 'the receipt made the retried create return the same page')
      assert.equal(copyPages[0]!.kind, subject.kind)
      assert.equal(h.server.text(copyPages[0]), 'mine\n')
      const open = [...h.server.conflicts.values()].filter((row) => row.state === 'open')
      assert.deepEqual(open.map((row) => row.reason), ['edited_on_both_sides'])
      assert.equal(open[0]!.copy?.pageId, copyPages[0]!.id)
    })
  }
}

test('a committed save whose answer was lost replays its receipt: no conflicted copy (C28)', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Receipt', content: 'v1\n' })
  await h.enable()
  await h.settle()
  await h.write('Projects/Receipt.md', 'v2\n')
  h.server.faults.push({ operation: 'write_document', mode: 'lose_answer' })
  let lost = false
  for (let pass = 0; pass < 4 && !lost; pass += 1) lost = await h.pass().then(() => false, () => true)
  assert.ok(lost)
  h.restart()
  await h.settle()
  assert.equal(h.server.text(h.server.pages.get(doc.id)), 'v2\n')
  assert.equal(h.server.pages.get(doc.id)!.versions.length, 2, 'the replay wrote nothing twice')
  assert.deepEqual(await conflictCopyOf(h, 'Projects'), [])
})

test('typing during an upload leaves the file dirty against the uploaded generation, then uploads again (A5)', async (t) => {
  let h!: Awaited<ReturnType<typeof createSyncHarness>>
  let typed = false
  h = await createSyncHarness({
    wrap: (transport) => ({
      ...transport,
      writeDocument: async (body) => {
        if (!typed) {
          typed = true
          await h.write('Projects/Live.md', 'one\ntwo\nthree\n')
        }
        return transport.writeDocument(body)
      },
    }),
  })
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Live', content: 'one\n' })
  await h.enable()
  await h.settle()
  await h.write('Projects/Live.md', 'one\ntwo\n')
  await h.settle()
  const page = h.server.pages.get(doc.id)!
  assert.deepEqual(page.versions.map((v) => Buffer.from(v.bytes).toString()), ['one\n', 'one\ntwo\n', 'one\ntwo\nthree\n'])
  assert.equal(await h.read('Projects/Live.md'), 'one\ntwo\nthree\n')
  assert.equal(h.server.conflicts.size, 0)
})

test('a download never replaces a file that changed between the plan and the rename (A8)', async (t) => {
  let h!: Awaited<ReturnType<typeof createSyncHarness>>
  let armed = false
  h = await createSyncHarness({
    wrap: (transport) => ({
      ...transport,
      download: async (pageId, versionId, part, byteLength) => {
        await transport.download(pageId, versionId, part, byteLength)
        if (armed) {
          armed = false
          await h.write('Projects/Race.md', 'typed just now\n')
        }
      },
    }),
  })
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Race', content: 'start\n' })
  await h.enable()
  await h.settle()
  h.server.actor.edit(doc.id, 'start\nfrom Nessie\n')
  armed = true
  await h.settle()
  const copies = await conflictCopyOf(h, 'Projects')
  const texts = [await h.read('Projects/Race.md'), ...await Promise.all(copies.map((name) => h.read(`Projects/${name}`)))]
  assert.ok(texts.includes('typed just now\n'), 'the local edit survived')
  assert.ok(texts.includes('start\nfrom Nessie\n'), 'Nessie\'s version is on disk too')
})

test('the server\'s rendering of a document and a re-encoded image become the file, without an upload loop (A11)', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  h.server.render = (markdown) => markdown.replace(/^\* /gmu, '- ')
  h.server.storeFile = (bytes, name) => (name.endsWith('.png') ? new Uint8Array([...bytes, 0]) : bytes)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Bullets', content: '- a\n' })
  await h.enable()
  await h.settle()
  await h.write('Projects/Bullets.md', '- a\n* b\n')
  await h.write('Projects/pic.png', new Uint8Array([7, 7]))
  await h.settle()
  assert.equal(await h.read('Projects/Bullets.md'), '- a\n- b\n')
  assert.equal(h.server.pages.get(doc.id)!.versions.length, 2)
  const { readFile } = await import('node:fs/promises')
  assert.deepEqual([...await readFile(h.path('Projects/pic.png'))], [7, 7, 0])
  assert.equal(h.server.find('Projects/pic.png')!.versions.length, 1)
  assert.equal((await h.state()).state, 'up_to_date')
})

test('Keep mine from Nessie applies while the row is as the person saw it; a stale choice re-reports the row (C32)', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'deck.bin', content: 'base' })
  await h.enable()
  await h.settle()
  h.server.actor.edit(doc.id, 'theirs')
  await h.write('Projects/deck.bin', 'mine')
  await h.settle()
  const [row] = [...h.server.conflicts.values()]
  assert.ok(row)
  h.server.instructions = {
    heldDeletes: null,
    resolveConflicts: [{ clientConflictId: row.clientConflictId, resolution: 'keep_mine', expectedOccurredAt: '2020-01-01T00:00:00.000Z' }],
  }
  h.server.actor.edit(doc.id, 'theirs again')
  await h.settle()
  const reopened = h.server.conflicts.get(row.clientConflictId)!
  assert.equal(reopened.state, 'open')
  assert.notEqual(reopened.occurredAt, row.occurredAt, 'the row came back with a new version')

  h.server.instructions = {
    heldDeletes: null,
    resolveConflicts: [{ clientConflictId: row.clientConflictId, resolution: 'keep_mine', expectedOccurredAt: reopened.occurredAt }],
  }
  await h.settle()
  await h.settle()
  assert.equal(h.server.text(h.server.pages.get(doc.id)), 'mine')
  assert.equal(await h.read('Projects/deck.bin'), 'mine')
  assert.equal(h.server.pages.get(row.copy!.pageId!)!.status, 'archived')
  assert.equal(h.server.conflicts.get(row.clientConflictId)!.state, 'resolved')
  assert.equal((await h.state()).state, 'up_to_date')
})

test('a missing folder marker is root_missing: nothing is archived (C21)', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Safe', content: 's\n' })
  await h.enable()
  await h.settle()
  const { rm: remove } = await import('node:fs/promises')
  await remove(join(h.root, `.nessie-sync-${h.server.executorId}`))
  await h.remove('Projects')
  await h.settle()
  assert.equal(h.server.pages.get(doc.id)!.status, 'live')
  assert.equal((await h.state()).state, 'root_missing')
})
