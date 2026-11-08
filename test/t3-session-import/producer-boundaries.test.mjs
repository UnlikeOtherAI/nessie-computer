// Eight review8a11f81 regressions, registered with the normal importer gate.
// Synthetic leases prove mechanics, not production authority. Authored/unrun.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HistoryPaging, ThreadStream } from '@nessie/t3-session-source/engine'
import { engineFixture } from './engine-fixture.mjs'
import { captureRetainedT3, resumeRetainedT3 } from '../../dist/t3-session/import/capture.js'
import { readRetainedProjection, readRetainedHistoryPage, readRetainedSnapshotWindow }
  from '../../dist/t3-session/import/reads.js'

const capture = f => captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
const args = (f, generation) => [f.ports, f.manifest, f.source.admittedRootKey, generation, f.ids[0]]
const deferred = () => {
  let resolve
  const promise = new Promise(accept => { resolve = accept })
  return { promise, resolve }
}

for (const boundary of ['original-owner', 'physical-source']) {
  for (const kind of ['projection', 'history', 'window']) {
    test(`review: ${kind} rejects advancement after the ${boundary} callback returns`, { timeout: 30_000 }, async () => {
      const f = await engineFixture({ messages: 360 })
      try {
        const first = await capture(f)
        // Resolve the original cursor using the same ordinary engine package as
        // the fixture, never an invented cursor or replacement history reducer.
        const snapshot = await readRetainedSnapshotWindow(...args(f, first.generation), {
          rowLimit: HistoryPaging.THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
        })
        const cursor = ThreadStream.buildBoundedThreadStreamSnapshot({ ...snapshot,
          compactTurnItems: true, dedupeBodies: true, compactIds: true }).historyCursor
        assert.ok(cursor)
        const entered = deferred()
        const release = deferred()
        const port = boundary === 'original-owner' ? f.ports.originalOwner : f.ports.source
        const method = boundary === 'original-owner' ? 'withReadScope' : 'withReadonlySource'
        let pause = true
        const intercepted = { ...port, [method]: async (...input) => {
          const use = input.pop()
          return port[method](...input, async (...callbackInput) => {
            const result = await use(...callbackInput)
            if (pause) {
              pause = false
              entered.resolve()
              await release.promise
            }
            return result
          })
        } }
        if (boundary === 'original-owner') f.ports.originalOwner = intercepted
        else f.ports.source = intercepted
        const read = kind === 'projection' ? generation => readRetainedProjection(...args(f, generation))
          : kind === 'history' ? generation => readRetainedHistoryPage(...args(f, generation), cursor)
            : generation => readRetainedSnapshotWindow(...args(f, generation), { rowLimit: 5 })
        const pending = read(first.generation)
        const outcome = pending.then(value => ({ value }), error => ({ error }))
        await entered.promise
        let second
        try {
          second = await capture(f)
          assert.notEqual(second.generation, first.generation)
        } finally { release.resolve() }
        const settled = await outcome
        assert.ok(settled.error, 'obsolete read escaped the enclosing producer boundary')
        assert.match(String(settled.error), /obsolete|unavailable|not_published/u)
        await read(second.generation)
      } finally { f.close() }
    })
  }
}

for (const operation of ['capture', 'resume']) {
  test(`review: late pre-snapshot ${operation} failure cannot poison a newer published capture`, { timeout: 30_000 }, async () => {
    const f = await engineFixture({ messages: 4 })
    try {
      const first = await capture(f)
      const source = f.ports.source
      const entered = deferred()
      const release = deferred()
      let failFirst = true
      f.ports.source = { ...source, withReadonlySource: async (...input) => {
        if (failFirst) {
          failFirst = false
          entered.resolve()
          await release.promise
          throw new Error('synthetic delayed opener failure')
        }
        return source.withReadonlySource(...input)
      } }
      const pending = operation === 'capture' ? capture(f)
        : resumeRetainedT3(f.ports, f.manifest, f.source.admittedRootKey, first.generation)
      const rejected = assert.rejects(pending, /retained_capture_incomplete/u)
      await entered.promise
      let second
      try { second = await capture(f) } finally { release.resolve() }
      await rejected
      assert.equal(f.ports.journal.root(f.source.physicalRootKey).generation, second.generation)
      assert.equal(f.ports.journal.root(f.source.physicalRootKey).available, 1)
      f.ports.journal.requirePublished(f.source.physicalRootKey, second.generation)
      await readRetainedProjection(...args(f, second.generation))
    } finally { f.close() }
  })
}

