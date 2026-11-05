import assert from 'node:assert/strict'
import test from 'node:test'
import { operationKeyFor, pageKeyFor } from '../src/folder-sync/reconcile-model.js'
import {
  addLocal, deleteLocal, deleteRemote, dirItem, editLocal, editRemote, effects, entryOf, fileItem, hash,
  moveLocalItem, ofType, pageId, reasons, run, setEntry, syncedWorld, types, updateRemote, versionId,
} from './folder-sync-fixtures.js'

/** Local and remote hierarchy, directory ownership and idempotency. */

const PASS = '50000000-0000-4000-8000-000000000001'

// ── Local structure ─────────────────────────────────────────────────────────

test('a folder moved here moves once in Nessie; its children follow without their own moves', () => {
  const world = syncedWorld([
    { n: 1, title: 'A', kind: 'folder' }, { n: 2, title: 'B', kind: 'folder' }, { n: 3, title: 'Plan', parent: 1 },
  ])
  moveLocalItem(world, 'Space/A', 'Space/B/A')
  const plan = run(world)
  assert.deepEqual(effects(plan), ['moveRemote'])
  const [move] = ofType(plan, 'moveRemote')
  assert.deepEqual([move!.pageId, move!.parent], [pageId(1), { type: 'existing', pageId: pageId(2) }])
})

test('a file moved into a new local folder names the folder\'s pending page as its parent', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  addLocal(world, dirItem('Space/New'))
  moveLocalItem(world, 'Space/Plan.md', 'Space/New/Plan.md')
  const plan = run(world)
  assert.deepEqual(effects(plan), ['createRemote', 'moveRemote'])
  assert.deepEqual(ofType(plan, 'moveRemote')[0]!.parent, { type: 'pending', pageKey: pageKeyFor(PASS, 'Space/New') })
})

test('two names swapped in Nessie go through parking names, never over each other', () => {
  const world = syncedWorld([{ n: 1, title: 'A', content: 'a' }, { n: 2, title: 'B', content: 'b' }])
  updateRemote(world, 1, { title: 'B' })
  updateRemote(world, 2, { title: 'A' })
  const moves = ofType(run(world), 'moveLocal').map((m) => [m.fromRelPath, m.toRelPath])
  assert.deepEqual(moves, [
    ['Space/A.md', `Space/.nessie-sync-move-${pageId(1).slice(0, 6)}`],
    ['Space/B.md', `Space/.nessie-sync-move-${pageId(2).slice(0, 6)}`],
    [`Space/.nessie-sync-move-${pageId(1).slice(0, 6)}`, 'Space/B.md'],
    [`Space/.nessie-sync-move-${pageId(2).slice(0, 6)}`, 'Space/A.md'],
  ])
})

test('a page taking the name of a page deleted in Nessie moves in after the old file is trashed', () => {
  const world = syncedWorld([
    { n: 1, title: 'Report', createdAt: '2026-01-01T00:00:00.000Z' },
    { n: 2, title: 'Report', createdAt: '2026-01-02T00:00:00.000Z' },
  ])
  deleteRemote(world, 1)
  const plan = run(world)
  assert.deepEqual(effects(plan), ['trashLocal', 'moveLocal'])
  assert.deepEqual(ofType(plan, 'moveLocal').map((m) => [m.fromRelPath, m.toRelPath]), [['Space/Report (2).md', 'Space/Report.md']])
})

test('new pages in Nessie download parents first', () => {
  const world = syncedWorld([])
  world.pages = syncedWorld([{ n: 1, title: 'F', kind: 'folder' }, { n: 2, title: 'Doc', parent: 1 }]).pages.reverse()
  assert.deepEqual(effects(run(world)), ['mkdir', 'download'])
})

test('a locked-by-editor file (A9) waits even when its stat is still', () => {
  const world = syncedWorld([{ n: 1, title: 'Report', kind: 'file', extension: 'docx' }])
  editLocal(world, 'Space/Report.docx', 'saving')
  addLocal(world, fileItem('Space/~$Report.docx', 'lock'))
  assert.deepEqual(effects(run(world)), [])
})

// ── Amendments ──────────────────────────────────────────────────────────────

test('A1 rename-then-upload: a rename in Nessie with the same content ancestor re-bases the upload, no conflict', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  editLocal(world, 'Space/Plan.md', 'mine')
  updateRemote(world, 1, { title: 'Renamed' })
  const plan = run(world)
  assert.deepEqual(effects(plan), ['moveLocal', 'upload'])
  assert.deepEqual(reasons(plan), [])
  const [upload] = ofType(plan, 'upload')
  assert.deepEqual(upload!.expect.base, {
    versionId: versionId(1), revision: 2, contentHash: entryOf(world, 1).base.contentHash,
  })
  assert.equal(upload!.relPath, 'Space/Renamed.md')
})

test('A1 delete-restore-stale-edit: archived page — the edit is kept as a new page, never written to the old one', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  editLocal(world, 'Space/Plan.md', 'stale edit')
  deleteRemote(world, 1)
  const plan = run(world)
  assert.equal(ofType(plan, 'upload').length, 0)
  assert.deepEqual(ofType(plan, 'createRemote').map((c) => c.relPath), ['Space/Plan.md'])
  // Restored later with a bumped revision and the same head: the upload is re-based on the restored revision.
  const restored = syncedWorld([{ n: 1, title: 'Plan' }])
  editLocal(restored, 'Space/Plan.md', 'stale edit')
  updateRemote(restored, 1, {})
  assert.equal(ofType(run(restored), 'upload')[0]!.expect.base.revision, 2)
})

test('A3: stale base, L == B, R modified — download only; typing after the plan is not erased', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan', content: 'base' }])
  editRemote(world, 1, 'remote', 11)
  const plan = run(world)
  assert.deepEqual(effects(plan), ['download'])
  assert.equal(ofType(plan, 'upload').length, 0)
  // The download overwrites only the bytes the plan saw: a keystroke since changes the hash and the install refuses.
  assert.equal(ofType(plan, 'download')[0]!.expect.local?.contentHash, hash('base'))
})

test('A4: while a conflict row is open, the canonical file\'s new edits go to the copy page as new versions', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan', content: 'head' }, { n: 2, title: 'Plan (conflicted copy)', content: 'first' }])
  setEntry(world, 1, {
    state: 'conflict',
    openConflict: { clientConflictId: 'c1', copyPageId: pageId(2), copyRelPath: 'Space/Plan (conflicted copy).md', copyHash: hash('first') },
  })
  editLocal(world, 'Space/Plan.md', 'second autosave')
  const plan = run(world)
  assert.deepEqual(effects(plan), ['upload'])
  const [upload] = ofType(plan, 'upload')
  assert.deepEqual([upload!.pageId, upload!.relPath], [pageId(2), 'Space/Plan.md'])
  assert.equal(ofType(plan, 'conflictCopy').length, 0)
})

test('A4/A12: once the copy holds the canonical bytes the entry is preserved, and a newer head may replace the file', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan', content: 'head' }, { n: 2, title: 'Plan (conflicted copy)', content: 'saved' }])
  setEntry(world, 1, {
    state: 'conflict',
    openConflict: { clientConflictId: 'c1', copyPageId: pageId(2), copyRelPath: 'Space/Plan (conflicted copy).md', copyHash: hash('saved') },
  })
  editLocal(world, 'Space/Plan.md', 'saved')
  assert.deepEqual(effects(run(world)), [])
  assert.equal(ofType(run(world), 'setEntryState')[0]!.state, 'preserved')
  editRemote(world, 1, 'newer head', 11)
  assert.deepEqual(effects(run(world)), ['download'])
})

test('A12: after the row is resolved (openConflict cleared) the next divergence is a fresh C1, never appended to the old copy', () => {
  const world = syncedWorld([{ n: 1, title: 'photo', kind: 'file', extension: 'png', mime: 'image/png' }, { n: 2, title: 'old copy.png', kind: 'file', extension: 'png' }])
  setEntry(world, 1, { openConflict: null })
  editLocal(world, 'Space/photo.png', 'late autosave')
  editRemote(world, 1, 'remote', 11)
  const plan = run(world)
  assert.equal(ofType(plan, 'conflictCopy').length, 1)
  assert.ok(ofType(plan, 'upload').every((upload) => upload.pageId !== pageId(2)))
  const alone = syncedWorld([{ n: 1, title: 'Plan' }, { n: 2, title: 'old copy' }])
  editLocal(alone, 'Space/Plan.md', 'late autosave')
  assert.deepEqual(ofType(run(alone), 'upload').map((u) => u.pageId), [pageId(1)])
})

test('A4: an open conflict whose copy page is gone from Nessie no longer redirects edits', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  setEntry(world, 1, { openConflict: { clientConflictId: 'c1', copyPageId: pageId(9), copyRelPath: 'Space/x.md', copyHash: null } })
  editLocal(world, 'Space/Plan.md', 'edit')
  assert.deepEqual(ofType(run(world), 'upload').map((u) => u.pageId), [pageId(1)])
})

test('A12: a conflict copy name avoids every name in the index and on disk', () => {
  const world = syncedWorld([{ n: 1, title: 'photo', kind: 'file', extension: 'png', mime: 'image/png' }])
  const taken = 'Space/photo (conflicted copy – Laptop – 1970-01-01 0246).png'
  addLocal(world, fileItem(taken, 'older copy'))
  editLocal(world, 'Space/photo.png', 'mine')
  editRemote(world, 1, 'theirs', 11)
  assert.equal(ofType(run(world), 'conflictCopy')[0]!.copyRelPath,
    'Space/photo (conflicted copy – Laptop – 1970-01-01 0246) (2).png')
})

test('A5: type-during-upload — base is the uploaded generation; a file that moved on stays dirty and uploads again', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan', content: 'uploaded' }])
  editLocal(world, 'Space/Plan.md', 'typed after the upload')
  const [upload] = ofType(run(world), 'upload')
  assert.equal(upload!.expect.base.contentHash, hash('uploaded'))
  assert.equal(upload!.expect.local?.contentHash, hash('typed after the upload'))
})

test('A2: operation keys are the same for the same write, whichever pass plans it', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  editLocal(world, 'Space/Plan.md', 'edit')
  const one = ofType(run(world), 'upload')[0]!.operationKey
  const two = ofType(run(world, { passId: '50000000-0000-4000-8000-000000000009' }), 'upload')[0]!.operationKey
  assert.equal(one, two)
  assert.equal(one, operationKeyFor('upload', pageId(1), 1, hash('edit')))
})

test('A12.6: a folder archive carries the subtree size the server checks', () => {
  const world = syncedWorld([{ n: 1, title: 'F', kind: 'folder' }, { n: 2, title: 'a', parent: 1 }, { n: 3, title: 'b', parent: 1 }])
  deleteLocal(world, 'Space/F')
  const archives = ofType(run(world), 'archiveRemote')
  assert.deepEqual(archives.map((a) => [a.pageId, a.descendantCount]), [[pageId(1), 2]])
})

test('#9: outside the scanned scope an absent file is never a delete', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }, { n: 2, title: 'Other', kind: 'folder' }])
  deleteLocal(world, 'Space/Plan.md')
  assert.deepEqual(effects(run(world, { scope: ['Space/Other'] })), [])
})

test('a synced entry with nothing to do and a stale state is set back to synced', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  setEntry(world, 1, { state: 'waiting', detail: { code: 'not_stable', message: '' } })
  assert.deepEqual(types(run(world)), ['setEntryState'])
})
