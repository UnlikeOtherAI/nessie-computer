import assert from 'node:assert/strict'
import test from 'node:test'

import { FolderSyncHeldDeletesSchema } from '@nessie/executor-protocol'

import { brakeDeletes, deleteBrakeLimit, heldBatchId } from '../src/folder-sync/plan-brake.js'
import type { ArchiveCandidate } from '../src/folder-sync/reconcile-entries.js'

const candidate = (n: number, affected = 1): ArchiveCandidate => ({
  action: {
    type: 'archiveRemote',
    pageId: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    operationKey: `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    relPath: `Space/file ${n}.md`,
    heldDeleteBatchId: null,
    descendantCount: affected - 1,
    descendantHash: `sha256:${'0'.repeat(64)}`,
    expect: { base: { versionId: null, revision: 1, contentHash: null }, local: null },
  },
  affected,
  spaceId: '10000000-0000-4000-8000-000000000001',
})
const many = (count: number) => Array.from({ length: count }, (_, index) => candidate(index + 1))

test('the limit is max(10, 20 %) of the team\'s entries', () => {
  assert.equal(deleteBrakeLimit(0), 10)
  assert.equal(deleteBrakeLimit(40), 10)
  assert.equal(deleteBrakeLimit(100), 20)
  assert.equal(deleteBrakeLimit(1000), 200)
})

test('up to the limit, archives go ahead', () => {
  const result = brakeDeletes(many(10), { entryCount: 30, missing: null, decision: null })
  assert.equal(result.archives.length, 10)
  assert.equal(result.held.length, 0)
  assert.equal(result.heldDeletes, null)
})

test('C23: more than the limit holds every archive of the pass, with a stable batch id', () => {
  const result = brakeDeletes(many(11), { entryCount: 30, missing: null, decision: null })
  assert.equal(result.archives.length, 0)
  assert.equal(result.held.length, 11)
  assert.equal(result.heldDeletes?.reason, 'mass_delete')
  assert.equal(result.heldDeletes?.count, 11)
  FolderSyncHeldDeletesSchema.parse(result.heldDeletes)
  const again = brakeDeletes([...many(11)].reverse(), { entryCount: 30, missing: null, decision: null })
  assert.equal(again.heldDeletes?.batchId, result.heldDeletes?.batchId)
})

test('a folder archive counts its whole subtree', () => {
  const result = brakeDeletes([candidate(1, 25)], { entryCount: 100, missing: null, decision: null })
  assert.equal(result.held.length, 1)
})

test('a missing space or team folder holds even a single delete', () => {
  for (const missing of ['space_folder_missing', 'team_folder_missing'] as const) {
    const result = brakeDeletes(many(1), { entryCount: 1000, missing, decision: null })
    assert.equal(result.held.length, 1)
    assert.equal(result.heldDeletes?.reason, missing)
  }
})

test('confirm for this batch releases every archive with the batch id', () => {
  const batchId = heldBatchId(many(11))
  const result = brakeDeletes(many(11), { entryCount: 30, missing: null, decision: { batchId, decision: 'confirm' } })
  assert.equal(result.archives.length, 11)
  assert.ok(result.archives.every((action) => action.heldDeleteBatchId === batchId))
  assert.equal(result.heldDeletes, null)
})

test('restore for this batch archives nothing and returns the batch to restore', () => {
  const batchId = heldBatchId(many(11))
  const result = brakeDeletes(many(11), { entryCount: 30, missing: null, decision: { batchId, decision: 'restore' } })
  assert.equal(result.archives.length, 0)
  assert.equal(result.restore.length, 11)
})

test('a decision for a batch that has since changed is not applied', () => {
  const batchId = heldBatchId(many(11))
  const result = brakeDeletes(many(12), { entryCount: 30, missing: null, decision: { batchId, decision: 'confirm' } })
  assert.equal(result.archives.length, 0)
  assert.equal(result.held.length, 12)
  assert.notEqual(result.heldDeletes?.batchId, batchId)
})

test('the sample is bounded and sorted', () => {
  const result = brakeDeletes(many(50), { entryCount: 60, missing: null, decision: null })
  assert.equal(result.heldDeletes?.sample.length, 20)
  assert.deepEqual(result.heldDeletes?.sample, [...result.heldDeletes!.sample].sort())
})
