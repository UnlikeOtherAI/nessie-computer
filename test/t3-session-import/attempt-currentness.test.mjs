import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { captureRetainedT3, resumeRetainedT3 } from '../../dist/t3-session/import/capture.js'
import { readRetainedProjection } from '../../dist/t3-session/import/reads.js'
import { engineFixture } from './engine-fixture.mjs'

const capture = f => captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
const resume = (f, generation) => resumeRetainedT3(f.ports, f.manifest, f.source.admittedRootKey, generation)
const read = (f, generation) => readRetainedProjection(f.ports, f.manifest,
  f.source.admittedRootKey, generation, f.ids[0])
const deferred = () => {
  let resolve
  const promise = new Promise(accept => { resolve = accept })
  return { promise, resolve }
}
const journal = f => new DatabaseSync(join(f.directory, 'local-capture-journal.sqlite'))

for (const operation of ['capture', 'resume']) {
  test(`current pre-snapshot ${operation} failure withdraws only its observed publication and retains evidence`, async () => {
    const f = await engineFixture({ messages: 4 })
    try {
      const first = await capture(f)
      const source = f.ports.source
      f.ports.source = { withReadonlySource: async () => { throw new Error('synthetic opener failure') } }
      await assert.rejects(operation === 'capture' ? capture(f) : resume(f, first.generation), /retained_capture_incomplete/u)
      assert.equal(f.ports.journal.root(f.source.physicalRootKey).available, 0)
      f.ports.source = source
      await assert.rejects(read(f, first.generation), /unavailable/u)
      const db = journal(f)
      try {
        const failed = db.prepare("SELECT * FROM t3_capture_attempts WHERE outcome = 'failed'").all()
        assert.equal(failed.length, 1)
        assert.equal(failed[0].physical_root, f.source.physicalRootKey)
        assert.equal(failed[0].generation, first.generation)
        assert.equal(failed[0].failure_code, 'retained_capture_incomplete')
        assert.equal(failed[0].withdrew, 1)
      } finally { db.close() }
      await resume(f, first.generation)
      await read(f, first.generation)
    } finally { f.close() }
  })
}

for (const operation of ['capture', 'resume']) {
  for (const change of ['same-generation-recovery', 'alias-aba']) {
    test(`late ${operation} opener failure cannot withdraw ${change}`, async () => {
      const f = await engineFixture({ messages: 4 })
      try {
        const first = await capture(f)
        const entered = deferred()
        const release = deferred()
        const source = f.ports.source
        let pause = true
        f.ports.source = { withReadonlySource: async (...args) => {
          if (pause) {
            pause = false
            entered.resolve()
            await release.promise
            throw new Error('synthetic delayed opener failure')
          }
          return source.withReadonlySource(...args)
        } }
        const pending = operation === 'capture' ? capture(f) : resume(f, first.generation)
        const rejected = assert.rejects(pending, /retained_capture_incomplete/u)
        await entered.promise
        try {
          if (change === 'same-generation-recovery') {
            f.ports.journal.unavailable(f.source.admittedRootKey)
            await resume(f, first.generation)
          } else {
            // A synthetic metadata reincarnation tests CAS, never a source handoff.
            const db = journal(f)
            try {
              db.prepare('DELETE FROM t3_capture_root_aliases WHERE admitted_root = ?').run(f.source.admittedRootKey)
              db.prepare('INSERT INTO t3_capture_root_aliases VALUES (?, ?)')
                .run(f.source.admittedRootKey, f.source.physicalRootKey)
            } finally { db.close() }
          }
        } finally { release.resolve() }
        await rejected
        f.ports.journal.requirePublished(f.source.physicalRootKey, first.generation)
        await read(f, first.generation)
        const db = journal(f)
        try {
          const failed = db.prepare("SELECT * FROM t3_capture_attempts WHERE outcome = 'failed'").all()
          assert.equal(failed.length, 1)
          assert.equal(failed[0].withdrew, 0)
        } finally { db.close() }
      } finally { f.close() }
    })
  }
}

test('an already obsolete resume cannot withdraw the generation observed at invocation', async () => {
  const f = await engineFixture({ messages: 4 })
  try {
    const first = await capture(f)
    const second = await capture(f)
    const source = f.ports.source
    f.ports.source = { withReadonlySource: async () => { throw new Error('synthetic opener failure') } }
    await assert.rejects(resume(f, first.generation), /retained_capture_incomplete/u)
    f.ports.source = source
    await read(f, second.generation)
  } finally { f.close() }
})
