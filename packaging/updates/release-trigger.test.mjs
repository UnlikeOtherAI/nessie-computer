import assert from 'node:assert/strict'
import test from 'node:test'
import { releaseRequest } from './release-trigger.mjs'
import { nextSequence } from './release-sequence.mjs'

test('published immutable version releases choose their channel; catalogue releases never recurse', () => {
  for (const prerelease of [false, true]) assert.deepEqual(releaseRequest({ tag_name: 'executor-v1.2.3', immutable: true, prerelease }),
    { version: '1.2.3', channel: prerelease ? 'preview' : 'stable' })
  for (const tag_name of ['update-catalog-stable-2', 'executor-v1.2.3;id', 'executor-v01.2.3', 'executor-v1.2.3-beta']) {
    assert.equal(releaseRequest({ tag_name, immutable: true }), undefined)
  }
  assert.equal(releaseRequest({ tag_name: 'executor-v1.2.3', draft: true }), undefined)
  assert.throws(() => releaseRequest({ tag_name: 'executor-v1.2.3' }), /immutable/)
})

test('automatic sequence advances, retries reuse it and stale release events cannot downgrade', () => {
  const current = { version: '1.2.3', sequence: 8, sourceCommit: 'a'.repeat(40) }
  assert.equal(nextSequence(current, '1.2.4', 'b'.repeat(40)), 9)
  assert.equal(nextSequence(current, '1.10.0', 'b'.repeat(40)), 9)
  assert.equal(nextSequence(current, '1.2.3', current.sourceCommit), 8)
  assert.throws(() => nextSequence(current, '1.2.2', current.sourceCommit), /backwards/)
  assert.throws(() => nextSequence(current, '1.2.3', 'b'.repeat(40)), /change source/)
})
