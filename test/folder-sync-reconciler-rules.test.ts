import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addLocal, deleteLocal, deleteRemote, editLocal, editRemote, effects, fileItem, moveLocalItem, ofType, pageId,
  reasons, run, space, syncedWorld, updateRemote,
} from './folder-sync-fixtures.js'

/** The reconciler’s governing rules R1–R7. */

// ── R1–R7 ───────────────────────────────────────────────────────────────────

test('R1: read-only wins — a renamed read-only page moves back and is never sent', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan', readOnlyReason: 'no_write_access' }])
  moveLocalItem(world, 'Space/Plan.md', 'Space/Renamed.md')
  const plan = run(world)
  assert.deepEqual(effects(plan), ['moveLocal'])
  assert.deepEqual(reasons(plan), ['read_only_no_write_access'])
  assert.equal(ofType(plan, 'moveRemote').length, 0)
})

test('R1: a read-only page deleted here comes back', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan', readOnlyReason: 'published' }])
  deleteLocal(world, 'Space/Plan.md')
  const plan = run(world)
  assert.deepEqual(effects(plan), ['download'])
  assert.deepEqual(reasons(plan), ['read_only_published'])
})

test('R1: a new file in a space the owner cannot write stays on disk and is never sent', () => {
  const world = syncedWorld([], [space({ writable: false })])
  addLocal(world, fileItem('Space/new.txt', 'x'))
  const plan = run(world)
  assert.deepEqual(effects(plan), [])
  assert.deepEqual(reasons(plan), ['read_only_no_write_access'])
})

test('R2: the server is the arbiter — its head keeps the canonical path, the local version becomes the copy', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  editLocal(world, 'Space/Plan.md', 'mine')
  editRemote(world, 1, 'theirs', 11)
  const plan = run(world)
  assert.equal(ofType(plan, 'download')[0]!.relPath, 'Space/Plan.md')
  assert.equal(ofType(plan, 'createRemote')[0]!.kind, 'document')
})

test('R3: no base text held (A7) means no merge — keep both, never a fabricated ancestor', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan', content: 'a\n' }])
  editLocal(world, 'Space/Plan.md', 'b\n')
  editRemote(world, 1, 'c\n', 11)
  assert.deepEqual(effects(run(world)), ['conflictCopy', 'createRemote', 'download'])
  const lossy = syncedWorld([{ n: 1, title: 'Notes', kind: 'file', extension: 'bin', mime: 'application/octet-stream' }])
  editLocal(lossy, 'Space/Notes.bin', 'b')
  editRemote(lossy, 1, 'c', 11)
  assert.equal(ofType(run(lossy, { mergeBases: new Set([pageId(1)]) }), 'merge').length, 0)
})

test('R4: edit beats delete, on either side', () => {
  const local = syncedWorld([{ n: 1, title: 'Plan' }])
  editLocal(local, 'Space/Plan.md', 'edit')
  deleteRemote(local, 1)
  assert.deepEqual(reasons(run(local)), ['deleted_in_nessie_edit_kept'])
  const remote = syncedWorld([{ n: 1, title: 'Plan' }])
  deleteLocal(remote, 'Space/Plan.md')
  editRemote(remote, 1, 'edit', 11)
  assert.deepEqual(reasons(run(remote)), ['deleted_here_restored'])
})

test('R5: deletes are soft — a local delete archives (never purges), a Nessie delete goes to the local trash', () => {
  const local = syncedWorld([{ n: 1, title: 'Plan' }])
  deleteLocal(local, 'Space/Plan.md')
  const [archive] = ofType(run(local), 'archiveRemote')
  assert.equal(archive!.pageId, pageId(1))
  assert.equal(archive!.expect.local, null)
  const remote = syncedWorld([{ n: 1, title: 'Plan' }])
  deleteRemote(remote, 1)
  assert.deepEqual(effects(run(remote)), ['trashLocal'])
})

test('R6: names are structural — a rename here alone is sent; one in Nessie alone is applied', () => {
  const local = syncedWorld([{ n: 1, title: 'Plan' }])
  moveLocalItem(local, 'Space/Plan.md', 'Space/Better.md')
  const [move] = ofType(run(local), 'moveRemote')
  assert.deepEqual([move!.title, move!.parent], ['Better', { type: 'existing', pageId: null }])
  const remote = syncedWorld([{ n: 1, title: 'Plan' }])
  updateRemote(remote, 1, { title: 'Better' })
  assert.deepEqual(ofType(run(remote), 'moveLocal').map((m) => m.toRelPath), ['Space/Better.md'])
})

test('R7: everything is told once — the same situation has the same row id, and a known row is not re-sent', () => {
  const world = syncedWorld([{ n: 1, title: 'Plan' }])
  editLocal(world, 'Space/Plan.md', 'edit')
  deleteRemote(world, 1)
  const first = ofType(run(world), 'recordConflict')[0]!.conflict
  const second = ofType(run(world, { passId: '50000000-0000-4000-8000-000000000002' }), 'recordConflict')[0]!.conflict
  assert.equal(first.clientConflictId, second.clientConflictId)
  assert.deepEqual(ofType(run(world, { knownConflictIds: new Set([first.clientConflictId]) }), 'recordConflict'), [])
})

