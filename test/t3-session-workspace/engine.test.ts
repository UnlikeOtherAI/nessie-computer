import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as DateTime from 'effect/DateTime'
import * as Schema from 'effect/Schema'
import { Workspace, Checkpoints, Rollback } from '@nessie/t3-session-source/engine'
import { ReviewDiffPreviewResult } from '@nessie/t3-session-source/contracts'

test('workspace implementations use the engine original checkpoint and rollback Context identities', () => {
  assert.equal(Workspace.Checkpoints.CheckpointServiceV2, Checkpoints.CheckpointServiceV2)
  assert.equal(Workspace.Rollback.CheckpointRollbackServiceV2, Rollback.CheckpointRollbackServiceV2)
  // @ts-expect-error Missing required owners must fail at both the type and runtime boundaries.
  assert.throws(() => Effect.runSync(Workspace.Review.make), /Service not found/)
  // @ts-expect-error An unbound Git service is not a runnable effect.
  assert.throws(() => Effect.runSync(Workspace.Git.make), /Service not found/)
})

test('actual original numstat decoder retains rename paths, binary changes and deleted files', () => {
  const files = Workspace.DiffFiles.parseTurnDiffFilesFromNumstat(
    '4\t2\t\0old č.ts\0new č.ts\0-\t-\timage.png\0' + '0\t8\tremoved.ts\0',
  )
  assert.deepEqual(files.find(file => file.path === 'new č.ts'), {
    path: 'new č.ts', previousPath: 'old č.ts', additions: 4, deletions: 2,
  })
  assert.deepEqual(files.find(file => file.path === 'image.png'), { path: 'image.png', additions: 0, deletions: 0 })
  assert.deepEqual(files.find(file => file.path === 'removed.ts'), { path: 'removed.ts', additions: 0, deletions: 8 })
})

test('original review codec retains deferred patches, incompleteness and truncation independently', () => {
  const result = Schema.decodeUnknownSync(ReviewDiffPreviewResult)({
    cwd: '/repo', generatedAt: DateTime.makeUnsafe('2026-11-08T12:00:00.000Z'), incomplete: true,
    sources: [{ id: 'source/1', kind: 'working-tree', title: 'Working tree', baseRef: null, headRef: null,
      diff: '', diffHash: 'hash', truncated: false, patchesDeferred: true,
      files: [{ path: 'new.ts', previousPath: 'old.ts', additions: 1, deletions: 1 }] }],
  })
  assert.equal(result.incomplete, true)
  assert.equal(result.sources[0]?.patchesDeferred, true)
  assert.equal(result.sources[0]?.truncated, false)
  assert.equal(result.sources[0]?.files?.[0]?.previousPath, 'old.ts')
})
