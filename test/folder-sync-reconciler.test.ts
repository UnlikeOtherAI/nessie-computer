import assert from 'node:assert/strict'
import test from 'node:test'
import { FOLDER_SYNC_TIMING } from '@nessie/executor-protocol'
import { heldBatchId } from '../src/folder-sync/plan-brake.js'
import {
  NOW, OTHER_SPACE_ID, SPACE_ID, addLocal, deleteLocal, deleteRemote, dirItem, editLocal, editRemote, effects,
  entryOf, fileItem, hash, moveLocalItem, ofType, pageId, reasons, run, setEntry, space, syncedWorld, updateRemote,
  versionId,
} from './folder-sync-fixtures.js'

/** Conflict-matrix cases C1–C27 plan exact actions and reason codes. */

// ── C1–C27 ──────────────────────────────────────────────────────────────────

test('C1: same file edited on both sides (binary) keeps both: copy aside, create the copy page, download head', () => {
  const world = syncedWorld([{ n: 1, title: 'photo', kind: 'file', extension: 'png', mime: 'image/png', content: 'v1' }])
  editLocal(world, 'Space/photo.png', 'local')
  editRemote(world, 1, 'remote', 11)
  const plan = run(world)
  assert.deepEqual(effects(plan), ['conflictCopy', 'createRemote', 'download'])
  assert.deepEqual(reasons(plan), ['edited_on_both_sides'])
  const [copy] = ofType(plan, 'conflictCopy')
  assert.equal(copy!.relPath, 'Space/photo.png')
  assert.equal(copy!.copyRelPath, 'Space/photo (conflicted copy – Laptop – 1970-01-01 0246).png')
  assert.equal(copy!.expect.local?.contentHash, hash('local'))
  const [created] = ofType(plan, 'createRemote')
  assert.equal(created!.relPath, copy!.copyRelPath)
  assert.equal(created!.title, 'photo (conflicted copy – Laptop – 1970-01-01 0246).png')
  const [download] = ofType(plan, 'download')
  assert.equal(download!.versionId, versionId(11))
  assert.equal(download!.expect.local, null)
})

test('C1 + R3: an exact Markdown document with its base held merges, with guarded keep-both follow-ups', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan', content: 'a\nb\n' }])
  editLocal(world, 'Space/Plan.md', 'A\nb\n')
  editRemote(world, 1, 'a\nB\n', 11)
  const plan = run(world, { mergeBases: new Set([pageId(1)]) })
  assert.deepEqual(effects(plan), ['merge', 'createRemote', 'download'])
  const [merge] = ofType(plan, 'merge')
  assert.equal(merge!.baseVersionId, versionId(1))
  assert.equal(merge!.remoteVersionId, versionId(11))
  assert.equal(merge!.fallback.reason, 'edited_on_both_sides')
  assert.equal(merge!.expect.base.versionId, versionId(11))
  // After a clean merge the copy does not exist and the path is not free: both follow-ups fail their checks.
  assert.equal(ofType(plan, 'createRemote')[0]!.expect.local?.contentHash, hash('A\nb\n'))
  assert.equal(ofType(plan, 'download')[0]!.expect.local, null)
  assert.deepEqual(ofType(plan, 'recordConflict'), [])
})

test('C2: edited locally, deleted in Nessie — a new page at the same path keeps the edit', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  editLocal(world, 'Space/Plan.md', 'my edit')
  deleteRemote(world, 1)
  const plan = run(world)
  assert.deepEqual(effects(plan), ['createRemote', 'forgetEntry'])
  assert.deepEqual(reasons(plan), ['deleted_in_nessie_edit_kept'])
  const [created] = ofType(plan, 'createRemote')
  assert.deepEqual([created!.kind, created!.title, created!.relPath], ['document', 'Plan', 'Space/Plan.md'])
  assert.deepEqual(created!.parent, { type: 'existing', pageId: null })
})

test('C3: edited in Nessie, deleted locally — the head comes back; the delete is not sent', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  deleteLocal(world, 'Space/Plan.md')
  editRemote(world, 1, 'newer', 11)
  const plan = run(world)
  assert.deepEqual(effects(plan), ['download'])
  assert.deepEqual(reasons(plan), ['deleted_here_restored'])
  assert.equal(ofType(plan, 'download')[0]!.relPath, 'Space/Plan.md')
})

test('C4: renamed differently on both sides — the file follows Nessie\'s name', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  moveLocalItem(world, 'Space/Plan.md', 'Space/Mine.md')
  updateRemote(world, 1, { title: 'Theirs' })
  const plan = run(world)
  assert.deepEqual(effects(plan), ['moveLocal'])
  assert.deepEqual(reasons(plan), ['renamed_in_nessie'])
  const [move] = ofType(plan, 'moveLocal')
  assert.deepEqual([move!.fromRelPath, move!.toRelPath], ['Space/Mine.md', 'Space/Theirs.md'])
})

test('C5a: folder deleted here, a child edited in Nessie — folder and child come back, the untouched sibling is archived', () => {
  const world = syncedWorld([
    { n: 1, title: 'Folder', kind: 'folder' },
    { n: 2, title: 'Changed', parent: 1 },
    { n: 3, title: 'Untouched', parent: 1 },
  ])
  deleteLocal(world, 'Space/Folder')
  editRemote(world, 2, 'newer', 12)
  const plan = run(world)
  assert.deepEqual(effects(plan), ['mkdir', 'download', 'archiveRemote'])
  assert.deepEqual(reasons(plan), ['folder_deleted_here_child_restored'])
  assert.equal(ofType(plan, 'archiveRemote')[0]!.pageId, pageId(3))
})

test('C5b: folder deleted in Nessie, a child edited here — folder and child are recreated, the sibling goes to the trash', () => {
  const world = syncedWorld([
    { n: 1, title: 'Folder', kind: 'folder' },
    { n: 2, title: 'Edited', parent: 1 },
    { n: 3, title: 'Untouched', parent: 1 },
  ])
  editLocal(world, 'Space/Folder/Edited.md', 'my edit')
  deleteRemote(world, 1)
  const plan = run(world)
  assert.deepEqual(effects(plan), ['trashLocal', 'createRemote', 'createRemote', 'forgetEntry', 'forgetEntry'])
  assert.deepEqual(reasons(plan), ['folder_deleted_in_nessie_child_recreated'])
  const [folder, child] = ofType(plan, 'createRemote')
  assert.equal(folder!.kind, 'folder')
  assert.deepEqual(child!.parent, { type: 'pending', pageKey: folder!.pageKey })
  assert.equal(ofType(plan, 'trashLocal')[0]!.pageId, pageId(3))
})

test('C6: create–create with identical bytes adopts; with different bytes keeps both', () => {
  const same = syncedWorld([])
  same.pages = [syncedWorld([{ n: 1, title: 'New', content: 'same' }]).pages[0]!]
  addLocal(same, fileItem('Space/New.md', 'same'))
  const adopt = run(same)
  assert.deepEqual(effects(adopt), ['adopt'])
  assert.equal(ofType(adopt, 'adopt')[0]!.base.contentHash, hash('same'))

  const different = syncedWorld([])
  different.pages = [syncedWorld([{ n: 1, title: 'New', content: 'theirs' }]).pages[0]!]
  addLocal(different, fileItem('Space/New.md', 'mine'))
  const plan = run(different)
  assert.deepEqual(effects(plan), ['conflictCopy', 'download', 'createRemote'])
  assert.deepEqual(reasons(plan), ['created_on_both_sides'])
  const [copy] = ofType(plan, 'conflictCopy')
  assert.equal(copy!.pageId, null)
  assert.equal(ofType(plan, 'createRemote')[0]!.relPath, copy!.copyRelPath)
})

test('C7: file in Nessie, folder here at the same path — the folder moves to (2), the file takes the path', () => {
  const world = syncedWorld([])
  world.pages = [syncedWorld([{ n: 1, title: 'Thing', kind: 'file', extension: null }]).pages[0]!]
  addLocal(world, dirItem('Space/Thing'))
  const plan = run(world)
  assert.deepEqual(effects(plan), ['moveLocal', 'download', 'createRemote'])
  assert.deepEqual(reasons(plan), ['type_changed'])
  assert.equal(ofType(plan, 'moveLocal')[0]!.toRelPath, 'Space/Thing (2)')
  assert.deepEqual([ofType(plan, 'createRemote')[0]!.kind, ofType(plan, 'createRemote')[0]!.title], ['folder', 'Thing (2)'])
})

test('C7: a local folder replacing a synced file is a delete of the file plus a create', () => {
  const world = syncedWorld([{ n: 1, title: 'Thing', kind: 'file', extension: null }])
  deleteLocal(world, 'Space/Thing')
  addLocal(world, dirItem('Space/Thing', { fileId: 'new-dir' }))
  const plan = run(world)
  assert.deepEqual(effects(plan), ['createRemote', 'archiveRemote'])
  assert.equal(ofType(plan, 'createRemote')[0]!.kind, 'folder')
})

test('C8: offline edits meet remote edits — planned from the last agreed base, never from now', () => {
  const world = syncedWorld([{ n: 1, title: 'photo', kind: 'file', extension: 'png', mime: 'image/png' }])
  setEntry(world, 1, { state: 'pending_upload' })
  editLocal(world, 'Space/photo.png', 'offline edit')
  editRemote(world, 1, 'meanwhile', 11)
  const plan = run(world)
  assert.deepEqual(reasons(plan), ['edited_on_both_sides'])
  assert.deepEqual(ofType(plan, 'conflictCopy')[0]!.expect.base, entryOf(world, 1).base)
})

test('C9 / T04: clock skew either way — an mtime a day off with the same hash is no change', () => {
  for (const mtimeMs of [NOW + 86_400_000, NOW - 86_400_000, 0]) {
    const world = syncedWorld([{ n: 1, title: 'Plan', content: 'same' }])
    editLocal(world, 'Space/Plan.md', 'same', { mtimeMs })
    assert.deepEqual(effects(run(world)), [])
  }
})

test('T05: equal mtime and size but different content is detected by hash', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan', content: 'aaaa' }])
  editLocal(world, 'Space/Plan.md', 'bbbb', { mtimeMs: 5, fileId: 'other-file' })
  assert.deepEqual(effects(run(world)), ['upload'])
})

test('C10: rapid saves in Nessie coalesce to one download of the newest head', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  editRemote(world, 1, 'v5', 15, 6)
  const plan = run(world)
  assert.deepEqual(effects(plan), ['download'])
  assert.equal(ofType(plan, 'download')[0]!.versionId, versionId(15))
})

test('C11: every write carries the base it was planned on, so a mid-sync agent edit becomes a 409, then C1', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  editLocal(world, 'Space/Plan.md', 'mine')
  const [upload] = ofType(run(world), 'upload')
  assert.deepEqual(upload!.expect.base, entryOf(world, 1).base)
  assert.deepEqual(upload!.expect.local, { fileId: 'file:Space/Plan.md', contentHash: hash('mine') })
})

test('C12: a spreadsheet re-downloads read-only; a held one waits and is reported after five minutes', () => {
  const world = syncedWorld([{ n: 1, title: 'Budget', kind: 'spreadsheet' }])
  editRemote(world, 1, 'sheet v2', 11)
  const [download] = ofType(run(world), 'download')
  assert.equal(download!.readOnly, true)

  const locked = syncedWorld([{ n: 1, title: 'Budget', kind: 'spreadsheet' }])
  editLocal(locked, 'Space/Budget.xlsx', 'excel saving', { unopenableSinceMs: NOW - FOLDER_SYNC_TIMING.waitingReportedAfterMs })
  const plan = run(locked)
  assert.deepEqual(reasons(plan), ['file_in_use'])
  assert.deepEqual(effects(plan), [])
})

test('C13 / R1: a read-only page edited here is quarantined beside the file and the mirror restored', () => {
  for (const [readOnlyReason, reason] of [
    ['document_formatting', 'read_only_document_formatting'],
    ['published', 'read_only_published'],
    ['no_write_access', 'read_only_no_write_access'],
  ] as const) {
    const world = syncedWorld([{ n: 1, title: 'Plan', readOnlyReason }])
    editLocal(world, 'Space/Plan.md', 'my edit')
    const plan = run(world)
    assert.deepEqual(effects(plan), ['quarantine', 'download'])
    assert.deepEqual(reasons(plan), [reason])
    const [quarantine] = ofType(plan, 'quarantine')
    assert.equal(quarantine!.copyRelPath, 'Space/Plan (your edit – not synced – 1970-01-01 0246).md')
    assert.equal(ofType(plan, 'upload').length, 0)
  }
  const sheet = syncedWorld([{ n: 1, title: 'Budget', kind: 'spreadsheet' }])
  editLocal(sheet, 'Space/Budget.xlsx', 'edited in Excel')
  assert.deepEqual(reasons(run(sheet)), ['read_only_spreadsheet'])
})

test('C14: access revoked — the space directory goes to the trash; an unsent edit goes too and is flagged', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }, { n: 2, title: 'Notes' }])
  editLocal(world, 'Space/Notes.md', 'unsent')
  world.spaces = []
  world.pages = []
  const plan = run(world)
  assert.deepEqual(effects(plan), ['trashLocal'])
  assert.deepEqual(ofType(plan, 'trashLocal')[0]!.relPath, 'Space')
  assert.deepEqual(reasons(plan).sort(), ['access_removed', 'access_removed_edit_kept'])

  const excluded = syncedWorld([{ n: 1, title: 'Plan' }])
  excluded.pages = []
  assert.deepEqual(effects(run(excluded, { excludedSpaceIds: [SPACE_ID] })), ['trashLocal'])
})

test('C15: a file over the upload ceiling is an error entry, never uploaded, never deleted', () => {
  const world = syncedWorld([{ n: 1, title: 'video', kind: 'file', extension: 'mp4' }])
  editLocal(world, 'Space/video.mp4', 'huge')
  const plan = run(world, { maxUploadBytes: 2 })
  assert.deepEqual(effects(plan), [])
  assert.deepEqual(reasons(plan), ['too_large'])
  assert.equal(ofType(plan, 'setEntryState')[0]!.state, 'error')
})

test('C16: a zero-byte file is an ordinary file', () => {
  const world = syncedWorld([])
  addLocal(world, fileItem('Space/empty.txt', ''))
  const [create] = ofType(run(world), 'createRemote')
  assert.equal(create!.expect.local?.contentHash, hash(''))
})

test('C17: a link replacing a synced file is reported, never followed, never a delete', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  world.items = world.items.map((item) => (item.relPath === 'Space/Plan.md' ? { ...item, type: 'link' as const } : item))
  addLocal(world, { ...dirItem('Space/linked'), type: 'link' })
  const plan = run(world)
  assert.deepEqual(effects(plan), [])
  assert.deepEqual(reasons(plan), ['link_not_synced', 'link_not_synced'])
})

test('C18: a file open elsewhere waits, and is reported once it has waited five minutes', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  editLocal(world, 'Space/Plan.md', 'saving', { unopenableSinceMs: NOW - 1_000 })
  const waiting = run(world)
  assert.deepEqual(effects(waiting), [])
  assert.deepEqual(ofType(waiting, 'setEntryState')[0]!.detail?.code, 'not_stable')
  editLocal(world, 'Space/Plan.md', 'saving', { unopenableSinceMs: NOW - FOLDER_SYNC_TIMING.waitingReportedAfterMs })
  assert.deepEqual(reasons(run(world)), ['file_in_use'])
})

test('C19: disk full is an engine state (T5 pauses downloads); the reconciler still plans them', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  editRemote(world, 1, 'newer', 11)
  assert.deepEqual(effects(run(world)), ['download'])
})

test('C20: a page too deep to map is reported and never blocks its siblings', () => {
  const specs = Array.from({ length: 5 }, (_, index) => ({
    n: index + 1, title: 'f'.repeat(199), kind: 'folder' as const, parent: index === 0 ? null : index,
  }))
  const world = syncedWorld([])
  world.pages = syncedWorld([...specs, { n: 9, title: 'deep', parent: 5 }, { n: 10, title: 'fine' }]).pages
  const plan = run(world)
  assert.ok(reasons(plan).includes('name_not_supported'))
  assert.ok(ofType(plan, 'download').some((download) => download.relPath === 'Space/fine.md'))
})

test('C21: the root or its marker missing plans nothing at all', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  world.items = []
  assert.deepEqual(run(world, { rootPresent: false }).actions, [])
})

test('C22: a non-empty folder — local files become pages; a clash with a page is C6', () => {
  const world = syncedWorld([])
  world.pages = [syncedWorld([{ n: 1, title: 'Shared', content: 'theirs' }]).pages[0]!]
  addLocal(world, fileItem('Space/Mine.txt', 'mine'))
  addLocal(world, fileItem('Space/Shared.md', 'other'))
  const plan = run(world)
  assert.deepEqual(reasons(plan), ['created_on_both_sides'])
  assert.deepEqual(ofType(plan, 'createRemote').map((c) => c.title).sort(), [
    'Mine.txt', 'Shared (conflicted copy – Laptop – 1970-01-01 0246).md',
  ])
})

test('C23: more than max(10, 20 %) deletes in a pass are held; a vanished space folder is held whatever the count', () => {
  const specs = Array.from({ length: 20 }, (_, index) => ({ n: index + 1, title: `doc ${index + 1}` }))
  const world = syncedWorld(specs)
  for (let n = 1; n <= 11; n += 1) deleteLocal(world, `Space/doc ${n}.md`)
  const plan = run(world)
  assert.equal(ofType(plan, 'archiveRemote').length, 0)
  assert.equal(ofType(plan, 'holdDelete').length, 11)
  assert.equal(plan.heldDeletes?.reason, 'mass_delete')

  const gone = syncedWorld([{ n: 1, title: 'Plan' }])
  deleteLocal(gone, 'Space')
  const held = run(gone)
  assert.deepEqual(effects(held), ['holdDelete'])
  assert.equal(held.heldDeletes?.reason, 'space_folder_missing')
  assert.equal(run(gone, { teamFolderPresent: false }).heldDeletes?.reason, 'team_folder_missing')
})

test('C23: confirming the held batch releases the archives; restoring brings the files back', () => {
  const specs = Array.from({ length: 20 }, (_, index) => ({ n: index + 1, title: `doc ${index + 1}` }))
  const world = syncedWorld(specs)
  for (let n = 1; n <= 11; n += 1) deleteLocal(world, `Space/doc ${n}.md`)
  const batchId = run(world).heldDeletes!.batchId
  const confirmed = run(world, { heldDecision: { batchId, decision: 'confirm' } })
  assert.equal(ofType(confirmed, 'archiveRemote').length, 11)
  assert.ok(ofType(confirmed, 'archiveRemote').every((a) => a.heldDeleteBatchId === batchId))
  const restored = run(world, { heldDecision: { batchId, decision: 'restore' } })
  assert.equal(ofType(restored, 'download').length, 11)
  assert.equal(ofType(restored, 'archiveRemote').length, 0)
  assert.equal(batchId, heldBatchId(ofType(run(world), 'holdDelete').map((h) => ({
    action: { pageId: h.pageId } as never, affected: 1, spaceId: SPACE_ID,
  }))))
})

test('C24: two computers offline-edit one file — the second to reconnect gets the conflicted copy', () => {
  const world = syncedWorld([{ n: 1, title: 'photo', kind: 'file', extension: 'png', mime: 'image/png' }])
  editLocal(world, 'Space/photo.png', 'second computer')
  editRemote(world, 1, 'first computer won', 11)
  assert.deepEqual(reasons(run(world)), ['edited_on_both_sides'])
})

test('C25: a page moved across spaces moves locally; a pending edit is re-based, not a conflict', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }], [space(), space({ id: OTHER_SPACE_ID, name: 'Other' })])
  editLocal(world, 'Space/Plan.md', 'pending edit')
  updateRemote(world, 1, { spaceId: OTHER_SPACE_ID })
  const plan = run(world)
  assert.deepEqual(effects(plan), ['moveLocal', 'upload'])
  assert.deepEqual(reasons(plan), [])
  assert.equal(ofType(plan, 'moveLocal')[0]!.toRelPath, 'Other/Plan.md')
  const [upload] = ofType(plan, 'upload')
  assert.equal(upload!.relPath, 'Other/Plan.md')
  assert.equal(upload!.expect.base.revision, 2)
  assert.equal(upload!.expect.base.versionId, versionId(1))
})

test('C26: a renamed space renames its directory once; nothing inside moves on its own', () => {
  const world = syncedWorld([{ n: 1, title: 'Folder', kind: 'folder' }, { n: 2, title: 'Plan', parent: 1 }])
  world.spaces = [space({ name: 'Renamed' })]
  const plan = run(world)
  assert.deepEqual(effects(plan), ['moveLocal'])
  const [move] = ofType(plan, 'moveLocal')
  assert.deepEqual([move!.pageId, move!.fromRelPath, move!.toRelPath], [null, 'Space', 'Renamed'])
})

test('C27: Markdown is sent as written; the server renders it (nothing refused here)', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  editLocal(world, 'Space/Plan.md', '<custom-widget>{{x}}</custom-widget>\n:::note\n')
  const [upload] = ofType(run(world), 'upload')
  assert.equal(upload!.kind, 'document')
})
