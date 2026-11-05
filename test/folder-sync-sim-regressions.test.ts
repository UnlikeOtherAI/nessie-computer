import assert from 'node:assert/strict'
import test from 'node:test'

import { refreshedEntries } from '../src/folder-sync/engine-entries.js'
import { isIgnoredPath } from '../src/folder-sync/ignore.js'
import { installFile } from '../src/folder-sync/local-fs.js'
import { mapTree } from '../src/folder-sync/path-mapping.js'
import {
  NOW, OTHER_SPACE_ID, SPACE_ID, deleteRemote, dirItem, editLocal, effects, entryOf, fileItem, moveLocalItem, ofType,
  hash, page, pageId, reasons, run, setEntry, space, syncedWorld, updateRemote,
} from './folder-sync-fixtures.js'
import { createSyncHarness } from './support/folder-sync-harness.js'
import { SimulatedCrash, armRenameCrash, disarmRenameCrash } from './support/folder-sync-sim/fs-hooks.js'

/**
 * Focused regressions for engine bugs the simulator found (each names its
 * seed in `support/folder-sync-sim/known-seeds.json`), pinned at the
 * reconciler where the rule lives.
 */

test('seed 2416: renamed on both sides to one name in another case — the file takes Nessie\'s spelling, no row', () => {
  const world = syncedWorld([{ n: 1, title: 'Roadmap' }])
  moveLocalItem(world, 'Space/Roadmap.md', 'Space/plan.md')
  updateRemote(world, 1, { title: 'Plan' })
  const plan = run(world)
  assert.deepEqual(effects(plan), ['moveLocal'])
  assert.deepEqual(reasons(plan), [])
  const [move] = ofType(plan, 'moveLocal')
  assert.deepEqual([move!.fromRelPath, move!.toRelPath], ['Space/plan.md', 'Space/Plan.md'])
})

test('renamed on both sides to the same name — the entry takes the new place, nothing is sent', () => {
  const world = syncedWorld([{ n: 1, title: 'Roadmap' }])
  moveLocalItem(world, 'Space/Roadmap.md', 'Space/Plan.md')
  updateRemote(world, 1, { title: 'Plan' })
  const plan = run(world)
  assert.deepEqual(effects(plan), ['adopt'])
  assert.deepEqual(reasons(plan), [])
  assert.equal(ofType(plan, 'adopt')[0]!.relPath, 'Space/Plan.md')
})

test('seed 2566: a file edited and then carried along by its folder\'s rename keeps its page', () => {
  for (const to of ['Space/DOCS', 'Space/Papers']) {
    const world = syncedWorld([{ n: 1, title: 'docs', kind: 'folder' }, { n: 2, title: 'Plan', parent: 1 }])
    editLocal(world, 'Space/docs/Plan.md', 'edited before the rename')
    moveLocalItem(world, 'Space/docs', to)
    const plan = run(world)
    assert.deepEqual(effects(plan), ['moveRemote', 'upload'], to)
    const [upload] = ofType(plan, 'upload')
    assert.deepEqual([upload!.pageId, upload!.relPath], [pageId(2), `${to}/Plan.md`])
  }
})

test('seed 1063: a new page waits while its parent folder cannot land, rather than make the directory for another entry', () => {
  const world = syncedWorld([{ n: 1, title: 'Work', kind: 'folder' }])
  // Renamed here a moment ago (still settling) and deleted in Nessie, where a new Work holds a new file.
  moveLocalItem(world, 'Space/Work', 'Space/x')
  world.items = world.items.map((item) => (item.relPath === 'Space/x' ? { ...item, stableSinceMs: NOW } : item))
  deleteRemote(world, 1)
  world.pages.push(page({ n: 2, title: 'Work', kind: 'folder' }), page({ n: 3, title: 'Report', parent: 2 }))
  const plan = run(world)
  assert.deepEqual(effects(plan), [])
  assert.equal(ofType(plan, 'setEntryState')[0]!.state, 'waiting')
})

test('seeds 2357, 2360: Keep mine picked in Nessie survives a lost answer, is carried out and reported resolved', async (t) => {
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
  assert.equal(h.server.resolveInNessie(row.clientConflictId, 'keep_mine', '2020-01-01T00:00:00.000Z'), false)
  assert.equal(h.server.resolveInNessie(row.clientConflictId, 'keep_mine', row.occurredAt), true)
  // The first answer carrying the choice is lost; Nessie relays it again.
  h.server.faults.push({ operation: 'report', mode: 'lose_answer' })
  await assert.rejects(h.pass())
  // The answer that does arrive is acted on, and the pass asks for another to carry it out.
  assert.equal((await h.pass()).more, true)
  await h.settle()
  assert.equal(h.server.conflicts.get(row.clientConflictId)!.state, 'resolved')
  assert.equal(h.server.text(h.server.pages.get(doc.id)), 'mine')
  assert.equal(h.server.pages.get(row.copy!.pageId!)!.status, 'archived')
  assert.equal((await h.state()).state, 'up_to_date')
})

test('seed 3694: a renamed space whose directory holds nothing tracked is still renamed', () => {
  const world = syncedWorld([])
  world.spaces = [space({ name: 'Team Space' })]
  const plan = run(world, { spaceDirs: { [SPACE_ID]: 'Space' } })
  const [move] = ofType(plan, 'moveLocal')
  assert.deepEqual([move?.fromRelPath, move?.toRelPath], ['Space', 'Team Space'])
})

test('a lost space whose directory holds nothing tracked still leaves the disk', () => {
  const world = syncedWorld([])
  world.items.push(dirItem('Old'))
  const plan = run(world, { spaceDirs: { [SPACE_ID]: 'Space', [OTHER_SPACE_ID]: 'Old' } })
  assert.deepEqual(effects(plan), ['trashLocal'])
  assert.equal(ofType(plan, 'trashLocal')[0]!.relPath, 'Old')
  assert.deepEqual(ofType(plan, 'recordConflict').map((action) => action.conflict.reason), ['access_removed'])
})

test('seed 797: a folder moved here into another space goes back; nothing asks Nessie to move it', () => {
  const world = syncedWorld([
    { n: 1, title: 'Work', kind: 'folder' },
    { n: 2, title: 'logo.bin', kind: 'file', parent: 1, extension: 'bin' },
  ], [space(), space({ id: OTHER_SPACE_ID, name: 'Other' })])
  world.items.push(dirItem('Other'))
  moveLocalItem(world, 'Space/Work', 'Other/Work')
  const plan = run(world)
  assert.deepEqual(effects(plan), ['moveLocal'])
  assert.deepEqual(ofType(plan, 'moveLocal').map((move) => [move.fromRelPath, move.toRelPath]), [['Other/Work', 'Space/Work']])
  assert.deepEqual(reasons(plan), ['moved_to_other_space'])
})

test('seed 625: an entry whose folder left its path does not take the folder another entry moved there', () => {
  // Work was renamed to Archive while the old Archive, moved by a person, still waited to settle.
  const world = syncedWorld([{ n: 1, title: 'Work', kind: 'folder' }, { n: 2, title: 'Archive', kind: 'folder' }])
  const work = { ...entryOf(world, 1), relPath: 'Space/Archive' }
  const archive = entryOf(world, 2)
  const manifest = { snapshotAt: 'x', spaces: world.spaces, excludedSpaceIds: [], pages: world.pages }
  const scanned = new Map([['Space/Archive', dirItem('Space/Archive', { fileId: work.local!.fileId })]])
  const changed = refreshedEntries([work, archive], manifest, scanned, () => true, NOW)
  const refreshed = changed.find((entry) => entry.pageId === pageId(2))
  assert.equal((refreshed ?? archive).local!.fileId, archive.local!.fileId)
})

test('seed 1092: a new file replanned after a refused create starts a new upload, not the old session', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  await h.enable()
  await h.settle()
  await h.write('Projects/file.bin', 'bytes')
  // The first create is refused once it completes (as when its parent went): the plan that follows has a
  // new page key, so its intent differs, and Nessie refuses a session key reused for another upload.
  h.server.faults.push({ operation: 'upload_complete', mode: 'refuse', status: 404, code: 'EXECUTOR_FOLDER_SYNC_NOT_FOUND' })
  for (let n = 0; n < 8 && !h.server.find('Projects/file.bin'); n += 1) {
    h.advance(10_000)
    await h.pass()
  }
  const file = h.server.find('Projects/file.bin')
  assert.ok(file, 'the file reached Nessie')
  assert.equal(h.server.text(file), 'bytes')
  assert.equal(h.server.uploads.size, 2)
})

test('Keep mine interrupted inside its replace: the replay puts the canonical file back and finishes', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'deck.bin', content: 'base' })
  await h.enable()
  await h.settle()
  h.server.actor.edit(doc.id, 'theirs')
  await h.write('Projects/deck.bin', 'mine')
  await h.settle()
  const [row] = [...h.server.conflicts.values()]
  assert.ok(row?.copy)
  assert.equal(h.server.resolveInNessie(row.clientConflictId, 'keep_mine', row.occurredAt), true)
  // Windows renames the canonical file aside before the copy takes its place: crash between the two
  // (elsewhere the copy is renamed straight over it: crash before that).
  if (process.platform === 'win32') armRenameCrash(h.teamDir(), 'after', 1, () => undefined)
  else armRenameCrash(h.teamDir(), 'before', 1, () => undefined)
  t.after(() => disarmRenameCrash(h.teamDir()))
  await assert.rejects(h.pass(), SimulatedCrash)
  disarmRenameCrash(h.teamDir())
  h.restart()
  await h.settle()
  assert.equal(await h.read('Projects/deck.bin'), 'mine')
  assert.equal(h.server.text(h.server.pages.get(doc.id)), 'mine')
  assert.equal(h.server.conflicts.get(row.clientConflictId)!.state, 'resolved')
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual((await readdir(h.path('Projects'))).filter((name) => name.startsWith('.nessie-sync-')), [])
})

test('a page named like a file the folder ignores is mirrored under a name it syncs, so its edits go back', () => {
  const pages = [
    page({ n: 1, title: 'x.tmp', kind: 'file', extension: 'tmp' }),
    page({ n: 2, title: '~$deck.docx', kind: 'file', extension: 'docx' }),
    page({ n: 3, title: 'Thumbs.db', kind: 'file', extension: 'db' }),
    page({ n: 4, title: 'Drafts.part', kind: 'folder' }),
    page({ n: 5, title: 'x', kind: 'file', extension: null }),
  ]
  const paths = mapTree([space()], pages).paths
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => paths.get(pageId(n))), [
    'Space/x.tmp_', 'Space/_~$deck.docx', 'Space/_Thumbs.db', 'Space/Drafts.part_', 'Space/x',
  ])
  for (const path of paths.values()) assert.equal(isIgnoredPath(path), false, path)
})

test('a local edit of a page named x.tmp reaches Nessie', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'x.tmp', content: 'base' })
  await h.enable()
  await h.settle()
  assert.equal(await h.read('Projects/x.tmp_'), 'base')
  await h.write('Projects/x.tmp_', 'edited here')
  h.advance(10_000)
  await h.settle()
  assert.equal(h.server.text(h.server.pages.get(doc.id)), 'edited here')
  assert.equal((await h.state()).state, 'up_to_date')
})

test('seeds 863, 5386: a folder Nessie put inside its own subfolder is lifted: park, child out, parent in', () => {
  const world = syncedWorld([
    { n: 1, title: 'docs', kind: 'folder' },
    { n: 2, title: 'docs', kind: 'folder', parent: 1 },
    { n: 3, title: 'plan', parent: 1 },
  ])
  updateRemote(world, 2, { parentPageId: null })
  updateRemote(world, 1, { parentPageId: pageId(2) })
  const plan = run(world)
  const park = `Space/.nessie-sync-move-${pageId(1).slice(0, 6)}`
  assert.deepEqual(effects(plan).filter((type) => type !== 'adopt'), ['moveLocal', 'moveLocal', 'moveLocal'])
  assert.deepEqual(ofType(plan, 'moveLocal').map((move) => [move.pageId, move.fromRelPath, move.toRelPath]), [
    [pageId(1), 'Space/docs', park],
    [pageId(2), `${park}/docs`, 'Space/docs'],
    [pageId(1), park, 'Space/docs/docs'],
  ])
  assert.deepEqual(ofType(plan, 'createRemote'), [])
})

test('seed 6648: a new file in its way is moved aside only once its folder\'s rename has carried it there', () => {
  // Nessie renamed docs to Work and made Work/Plan; here a different docs/Plan.md was written meanwhile.
  const world = syncedWorld([{ n: 1, title: 'docs', kind: 'folder' }])
  updateRemote(world, 1, { title: 'Work' })
  world.pages.push(page({ n: 2, title: 'Plan', parent: 1, content: 'theirs' }))
  world.items.push(fileItem('Space/docs/Plan.md', 'mine'))
  const first = run(world)
  assert.deepEqual(effects(first), ['moveLocal'])
  assert.deepEqual(ofType(first, 'moveLocal').map((move) => [move.fromRelPath, move.toRelPath]), [['Space/docs', 'Space/Work']])
  // Next pass, from where the rename put it, it is the ordinary C6: kept as a conflicted copy.
  moveLocalItem(world, 'Space/docs', 'Space/Work')
  world.entries = world.entries.map((entry) => ({ ...entry, relPath: 'Space/Work', title: 'Work' }))
  assert.deepEqual(reasons(run(world)), ['created_on_both_sides'])
})

test('seed 8886: an install that cannot put its engine-made source back leaves no hidden staged file', async (t) => {
  const { mkdtemp, mkdir, readdir, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'nessie-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'Space'))
  await mkdir(join(root, 'pending'))
  await writeFile(join(root, 'Space', 'Plan.md'), 'the person typed this')
  await writeFile(join(root, 'pending', 'part'), 'downloaded')
  // The target changed (drift); putting the staged download back then fails.
  armRenameCrash(root, 'before', 2, () => undefined)
  t.after(() => disarmRenameCrash(root))
  await assert.rejects(installFile(root, join(root, 'pending', 'part'), join(root, 'Space', 'Plan.md'), {
    expectHash: 'sha256:not-what-is-there', readOnly: false,
  }))
  assert.deepEqual(await readdir(join(root, 'Space')), ['Plan.md'])
})

test('seed 8149: a file whose conflict is open still follows a rename in Nessie, and its edits still go to the copy', () => {
  const world = syncedWorld([
    { n: 1, title: 'logo.bin', kind: 'file', extension: 'bin' },
    { n: 2, title: 'logo (conflicted copy).bin', kind: 'file', extension: 'bin', content: 'copy' },
  ])
  setEntry(world, 1, {
    openConflict: {
      clientConflictId: 'c1', copyPageId: pageId(2), copyRelPath: 'Space/logo (conflicted copy).bin', copyHash: hash('copy'),
    },
  })
  editLocal(world, 'Space/logo.bin', 'typed again')
  updateRemote(world, 1, { title: 'plan.bin' })
  const plan = run(world)
  assert.deepEqual(ofType(plan, 'moveLocal').map((move) => [move.fromRelPath, move.toRelPath]), [
    ['Space/logo.bin', 'Space/plan.bin'],
  ])
  const [upload] = ofType(plan, 'upload')
  assert.deepEqual([upload!.pageId, upload!.relPath], [pageId(2), 'Space/plan.bin'])
})
