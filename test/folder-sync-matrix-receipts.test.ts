import assert from 'node:assert/strict'
import test from 'node:test'

import { createMatrix, type Computer } from './support/folder-sync-sim/matrix-world.js'

/** The conflict matrix, C25–C36: moves across spaces, renamed spaces, receipts, generations and guarded resolution. */

const reasons = (computer: Computer) => computer.openRows().map((row) => row.reason)
const texts = (page: { versions: Array<{ bytes: Uint8Array }> }) =>
  page.versions.map((version) => Buffer.from(version.bytes).toString())

test('C25 a page moved to another space in Nessie moves here, and its pending edit goes with it — no conflict', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const shared = w.server.actor.space('Shared')
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Travel', content: 'a\n' })
  await w.start()
  await w.pc.write('Projects/Travel.md', 'a\nmine\n')
  w.server.actor.move(doc.id, null, shared.id)
  await w.pc.settle()
  assert.equal(await w.pc.readOrNull('Projects/Travel.md'), null)
  assert.equal(await w.pc.read('Shared/Travel.md'), 'a\nmine\n')
  assert.deepEqual(texts(doc), ['a\n', 'a\nmine\n'])
  assert.deepEqual(w.pc.rows(), [])
})

test('C26 a space renamed in Nessie renames its folder here; a pending edit is re-pathed, not re-uploaded', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Plan', content: 'p\n' })
  await w.start()
  await w.pc.write('Projects/Plan.md', 'p\nmine\n')
  w.space.name = 'Work'
  w.server.record({ spaceId: w.space.id, pageId: null, kind: 'space_updated', versionId: null, revision: null, parentPageId: null, title: null }, null)
  await w.pc.settle()
  assert.deepEqual(await w.pc.list('.'), ['Work'])
  assert.equal(await w.pc.read('Work/Plan.md'), 'p\nmine\n')
  assert.deepEqual(texts(doc), ['p\n', 'p\nmine\n'])
  assert.deepEqual(w.pc.rows(), [])
})

test('C27 Markdown the editor cannot hold is still sent: nothing is refused', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Odd', content: 'x\n' })
  await w.start()
  const odd = '<div class="widget">[[Wiki link]]</div>\n::: note\n| a |\n'
  await w.pc.write('Projects/Odd.md', odd)
  await w.pc.settle()
  assert.equal(w.server.text(doc), odd)
  assert.equal((await w.pc.state()).state, 'up_to_date')
})

for (const subject of [
  { name: 'a file upload', operation: 'upload_complete', title: 'blob.txt', kind: 'file' as const },
  { name: 'a document write', operation: 'write_document', title: 'Note', kind: 'document' as const },
]) {
  test(`C28 ${subject.name} committed but its answer lost replays its receipt: one version, no copy`, async (t) => {
    const w = await createMatrix()
    t.after(w.cleanup)
    const page = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: subject.kind, title: subject.title, content: 'v1\n' })
    await w.start()
    const file = subject.kind === 'document' ? `Projects/${subject.title}.md` : `Projects/${subject.title}`
    await w.pc.write(file, 'v2\n')
    w.pc.view.faults.push({ operation: subject.operation, mode: 'lose_answer' })
    let lost = false
    for (let pass = 0; pass < 4 && !lost; pass += 1) lost = (await w.pc.pass()).kind === 'failed'
    assert.ok(lost)
    w.pc.restart()
    await w.pc.settle()
    assert.deepEqual(texts(page), ['v1\n', 'v2\n'])
    assert.deepEqual(await w.pc.copies('Projects'), [])
    assert.equal((await w.pc.state()).state, 'up_to_date')
  })
}

test('C28 a move and an archive whose answers were lost take effect once', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const moved = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Old name', content: 'm\n' })
  const gone = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Gone', content: 'g\n' })
  await w.start()
  await w.pc.rename('Projects/Old name.md', 'Projects/New name.md')
  await w.pc.remove('Projects/Gone.md')
  w.pc.view.faults.push({ operation: 'move', mode: 'lose_answer' }, { operation: 'archive', mode: 'lose_answer' })
  for (let pass = 0; pass < 6; pass += 1) await w.pc.pass()
  await w.pc.settle()
  assert.equal(moved.title, 'New name')
  assert.equal(gone.status, 'archived')
  const effects = w.server.audit.effects.filter((effect) => effect.kind === 'move' || effect.kind === 'archive')
  assert.deepEqual(effects.map((effect) => effect.kind).sort(), ['archive', 'move'])
})

test('C29 an upload completed whose answer was lost, retried after its session expired: the receipt answers, nothing is written twice', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const page = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'file', title: 'data.bin', content: 'v1' })
  await w.start()
  await w.pc.write('Projects/data.bin', 'v2')
  w.pc.view.faults.push({ operation: 'upload_complete', mode: 'lose_answer' })
  let lost = false
  for (let pass = 0; pass < 4 && !lost; pass += 1) lost = (await w.pc.pass()).kind === 'failed'
  assert.ok(lost)
  w.pc.view.uploads.clear()
  await w.pc.settle()
  assert.deepEqual(texts(page), ['v1', 'v2'])
  assert.equal((await w.pc.state()).state, 'up_to_date')
})

test('C30 typing continues during an upload: the base moves to what was sent and the newer text uploads next (A5)', async (t) => {
  let typed = false
  const w = await createMatrix()
  t.after(w.cleanup)
  // A document: its text is read whole and released before it is sent, so the
  // editor's save lands (a file upload holds an exclusive open on Windows, A9).
  const page = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Live', content: 'one\n' })
  w.hook.current = async (_who, operation) => {
    if (!typed && operation === 'writeDocument') {
      typed = true
      await w.pc.write('Projects/Live.md', 'one\ntwo\nthree\n')
    }
  }
  await w.start()
  typed = false
  await w.pc.write('Projects/Live.md', 'one\ntwo\n')
  await w.pc.settle()
  assert.deepEqual(texts(page), ['one\n', 'one\ntwo\n', 'one\ntwo\nthree\n'])
  assert.deepEqual(w.pc.rows(), [])
})

const conflictOn = async (title: string) => {
  const w = await createMatrix()
  const page = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'file', title, content: 'base' })
  await w.start()
  w.server.actor.edit(page.id, 'theirs')
  await w.pc.write(`Projects/${title}`, 'mine')
  await w.pc.settle()
  await w.pc.settle()
  const [row] = w.pc.openRows()
  assert.ok(row?.copy?.pageId)
  return { w, page, row, copyPage: w.server.pages.get(row.copy.pageId)! }
}

test('C31 autosave while the conflict is open goes to the copy page — never a second copy (A4)', async (t) => {
  const { w, page, copyPage } = await conflictOn('deck.bin')
  t.after(w.cleanup)
  for (const text of ['mine 2', 'mine 3']) {
    await w.pc.write('Projects/deck.bin', text)
    await w.pc.settle()
  }
  assert.equal((await w.pc.copies('Projects')).length, 1)
  assert.equal(w.server.text(copyPage), 'mine 3')
  assert.deepEqual(texts(page), ['base', 'theirs'], 'the canonical page is not written while the row is open')
  assert.equal(w.pc.openRows().length, 1)
})

test('C31 autosave after the conflict was resolved is planned afresh, never appended to the old copy', async (t) => {
  const { w, page, row, copyPage } = await conflictOn('deck.bin')
  t.after(w.cleanup)
  await w.pc.command({ command: 'resolve', clientConflictId: row.clientConflictId, resolution: 'dismiss' })
  await w.pc.settle()
  const copyVersions = copyPage.versions.length
  await w.pc.write('Projects/deck.bin', 'after resolving')
  await w.pc.settle()
  assert.equal(w.server.text(page), 'after resolving')
  assert.equal(copyPage.versions.length, copyVersions, 'the old copy is untouched')
  assert.equal((await w.pc.copies('Projects')).length, 1)
  assert.equal((await w.pc.state()).state, 'up_to_date')
})

test('C32 Keep mine racing a copy that moved on is re-reported open with a new occurredAt; nothing changes in Nessie', async (t) => {
  const { w, page, row } = await conflictOn('deck.bin')
  t.after(w.cleanup)
  const seen = w.pc.view.conflicts.get(row.clientConflictId)!.occurredAt
  await w.pc.write(`Projects/${row.copy!.relPath.split('/').pop()}`, 'mine, edited in the copy')
  w.pc.view.instructions = { heldDeletes: null, resolveConflicts: [{ clientConflictId: row.clientConflictId, resolution: 'keep_mine', expectedOccurredAt: seen }] }
  await w.pc.settle()
  const reopened = w.pc.view.conflicts.get(row.clientConflictId)!
  assert.equal(reopened.state, 'open')
  assert.notEqual(reopened.occurredAt, seen)
  assert.equal(w.server.text(page), 'theirs')
  assert.deepEqual(reasons(w.pc), ['edited_on_both_sides'])
})

test('C33 three writers from one base: the first is written, identical bytes are already current, a different one is C1', async (t) => {
  const w = await createMatrix({ computers: 3 })
  t.after(w.cleanup)
  const [a, b, c] = w.computers as [Computer, Computer, Computer]
  const page = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'file', title: 'tri.bin', content: 'base' })
  await w.start()
  await a.write('Projects/tri.bin', 'same')
  await b.write('Projects/tri.bin', 'same')
  await c.write('Projects/tri.bin', 'other')
  await a.settle()
  await b.settle()
  await c.settle()
  await w.settleAll()
  assert.deepEqual(texts(page), ['base', 'same'])
  assert.deepEqual(reasons(a), [])
  assert.deepEqual(reasons(b), [])
  assert.deepEqual(reasons(c), ['edited_on_both_sides'])
  assert.equal((await b.state()).state, 'up_to_date')
})

test('C34 a page archived while its upload was in flight: the bytes become a new page (the server-side purge race is T2\'s)', async (t) => {
  let armed = false
  const w = await createMatrix()
  t.after(w.cleanup)
  const page = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'file', title: 'late.bin', content: 'v1' })
  w.hook.current = async (_who, operation) => {
    if (armed && operation === 'uploadFile') {
      armed = false
      w.server.actor.archive(page.id)
    }
  }
  await w.start()
  await w.pc.write('Projects/late.bin', 'v2 here')
  armed = true
  await w.pc.settle()
  await w.pc.settle()
  assert.equal(page.status, 'archived')
  assert.equal(w.text('Projects/late.bin'), 'v2 here')
  assert.deepEqual(reasons(w.pc), ['deleted_in_nessie_edit_kept'])
})

test('C35 delete, restore, then an old edit: the restore moved the revision on, the edit replans and lands once', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  const page = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Phoenix', content: 'one\n' })
  await w.start()
  w.pc.view.offline = true
  await w.pc.write('Projects/Phoenix.md', 'one\nmine\n')
  await w.pc.pass()
  w.server.actor.archive(page.id)
  page.status = 'live'
  page.archiveOperationId = null
  page.revision += 1
  w.server.record({ spaceId: page.spaceId, pageId: page.id, kind: 'page_restored', versionId: null, revision: page.revision, parentPageId: null, title: page.title }, null)
  w.pc.view.offline = false
  await w.pc.settle()
  assert.deepEqual(texts(page), ['one\n', 'one\nmine\n'])
  assert.deepEqual(await w.pc.copies('Projects'), [])
  assert.deepEqual(w.server.audit.violations, [])
})

test('C36 a save of the head is already_current; a save of the old base while the head moved on is remote_only — no version, no 409', async (t) => {
  const w = await createMatrix({ computers: 2 })
  t.after(w.cleanup)
  const [a, b] = w.computers as [Computer, Computer]
  const page = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Same', content: 'base\n' })
  await w.start()
  await a.write('Projects/Same.md', 'both\n')
  await b.write('Projects/Same.md', 'both\n')
  await w.settleAll()
  assert.deepEqual(texts(page), ['base\n', 'both\n'])
  assert.deepEqual([...reasons(a), ...reasons(b)], [])
  const base = page.versions[0]!
  w.server.actor.edit(page.id, 'newer\n')
  const answer = await a.replica.transport.writeDocument({
    operationKey: '00000000-0000-4000-8000-000000000036', pageId: page.id, baseRevision: page.revision,
    baseVersionId: base.versionId, markdown: 'base\n', changeComment: 'replayed',
  })
  assert.equal(answer.outcome, 'remote_only')
  assert.equal(page.versions.length, 3)
  await a.settle()
  assert.equal(await a.read('Projects/Same.md'), 'newer\n')
})

test('C31 Keep Nessie\'s after the canonical file diverged into the copy: Nessie\'s head stays, the file shows it, the edit stays in the copy', async (t) => {
  const { w, page, row, copyPage } = await conflictOn('deck.bin')
  t.after(w.cleanup)
  await w.pc.write('Projects/deck.bin', 'mine 2')
  await w.pc.settle()
  assert.equal(w.server.text(copyPage), 'mine 2')
  // The copy moved on since the row was raised: the first choice re-reports it (C32), the second applies.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await w.pc.command({ command: 'resolve', clientConflictId: row.clientConflictId, resolution: 'keep_nessie' })
    await w.pc.settle()
  }
  await w.pc.settle()
  assert.equal(w.pc.view.conflicts.get(row.clientConflictId)?.state, 'resolved')
  assert.equal(w.server.text(page), 'theirs', 'Keep Nessie\'s never sends the edit as the canonical page')
  assert.equal(await w.pc.read('Projects/deck.bin'), 'theirs')
  assert.ok(texts(copyPage).includes('mine 2'), 'the edit is still in Nessie')
})

test('A1 a rename in Nessie between planning and completing an upload: the same bytes go again at the new revision, in a new session', async (t) => {
  let armed = false
  const w = await createMatrix()
  t.after(w.cleanup)
  const page = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'file', title: 'data.bin', content: 'v1' })
  w.hook.current = async (_who, operation) => {
    if (armed && operation === 'uploadFile') {
      armed = false
      w.server.actor.rename(page.id, 'renamed.bin')
    }
  }
  await w.start()
  await w.pc.write('Projects/data.bin', 'v2')
  armed = true
  await w.pc.settle()
  assert.deepEqual(texts(page), ['v1', 'v2'])
  assert.equal(await w.pc.read('Projects/renamed.bin'), 'v2')
  assert.deepEqual(w.pc.rows(), [])
  assert.equal((await w.pc.state()).state, 'up_to_date')
})
