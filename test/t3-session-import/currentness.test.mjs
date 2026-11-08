import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import * as DateTime from 'effect/DateTime'
import { SourceContracts as S, ThreadStream } from '@nessie/t3-session-source/engine'
import { captureRetainedT3, resumeRetainedT3 } from '../../dist/t3-session/import/capture.js'
import { readRetainedProjection, readRetainedHistoryPage, readRetainedSnapshotWindow } from '../../dist/t3-session/import/reads.js'
import { engineFixture } from './engine-fixture.mjs'

const capture = f => captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
const resume = (f, generation) => resumeRetainedT3(f.ports, f.manifest, f.source.admittedRootKey, generation)
const args = (f, generation) => [f.ports, f.manifest, f.source.admittedRootKey, generation, S.ThreadId.make(f.ids[0])]

for (const operation of ['capture', 'resume']) {
  test(`${operation} cannot return a ready receipt after advancement during final lease recheck`, async () => {
    const f = await engineFixture({ messages: 4 })
    try {
      const first = await capture(f)
      let completed = false
      const complete = f.ports.journal.complete.bind(f.ports.journal)
      f.ports.journal.complete = (...input) => { complete(...input); completed = true }
      f.ports.originalOwner = { withReadScope: async (_input, use) => use({
        recheckThread: async () => {},
        recheckSource: async () => {
          if (completed) {
            completed = false
            f.ports.journal.begin(f.source, 'advanced-at-return', 'advanced-at-return')
          }
        },
      }) }
      await assert.rejects(operation === 'capture' ? capture(f) : resume(f, first.generation), /obsolete/u)
      assert.equal(f.ports.journal.root(f.source.physicalRootKey).generation, 'advanced-at-return')
      assert.equal(f.ports.journal.root(f.source.physicalRootKey).available, 1)
    } finally { f.close() }
  })
}

for (const kind of ['projection', 'history', 'window']) {
  test(`${kind} reads only the available published generation, fencing advancement and revocation during awaits`, async () => {
    const f = await engineFixture({ messages: 360 })
    try {
      const g1 = (await capture(f)).generation
      const snapshot = await readRetainedSnapshotWindow(...args(f, g1), { rowLimit: 5 })
      const cursor = ThreadStream.buildBoundedThreadStreamSnapshot({ ...snapshot,
        compactTurnItems: true, dedupeBodies: true, compactIds: true }).historyCursor
      assert.ok(cursor)
      const read = generation => kind === 'projection' ? readRetainedProjection(...args(f, generation))
        : kind === 'history' ? readRetainedHistoryPage(...args(f, generation), cursor)
          : readRetainedSnapshotWindow(...args(f, generation), { rowLimit: 5 })
      await read(g1)
      let g2 = (await capture(f)).generation
      await assert.rejects(read(g1), /obsolete/u)
      await read(g2)
      f.ports.journal.unavailable(f.source.admittedRootKey)
      await assert.rejects(read(g2), /unavailable/u)
      await resume(f, g2)
      const reopen = f.ports.workspace.reopenGeneration
      // The real engine query still executes; publication becomes unavailable
      // across an actual awaited workspace opening, before final-return arbitration.
      f.ports.workspace.reopenGeneration = async ref => {
        const stage = await reopen(ref)
        f.ports.journal.unavailable(f.source.admittedRootKey)
        return stage
      }
      await assert.rejects(read(g2), /unavailable/u)
      f.ports.workspace.reopenGeneration = reopen
      await resume(f, g2)
      const owner = f.ports.originalOwner
      let revoked = false
      f.ports.originalOwner = { withReadScope: async (_input, use) => use({
        recheckSource: async () => { assert.equal(revoked, false, 'synthetic owner revoked') },
        recheckThread: async () => { assert.equal(revoked, false, 'synthetic owner revoked') },
      }) }
      f.ports.workspace.reopenGeneration = async ref => { const stage = await reopen(ref); revoked = true; return stage }
      await assert.rejects(read(g2), /revoked/u)
      f.ports.originalOwner = owner
      f.ports.workspace.reopenGeneration = async ref => {
        f.ports.workspace.reopenGeneration = reopen
        const stage = await reopen(ref)
        await capture(f)
        return stage
      }
      await assert.rejects(read(g2), /obsolete/u)
      g2 = f.ports.journal.root(f.source.physicalRootKey).generation
      await read(g2)
      f.ports.workspace.reopenGeneration = async ref => {
        const stage = await reopen(ref)
        f.ports.journal.begin(f.source, 'concurrent', 'concurrent')
        return stage
      }
      await assert.rejects(read(g2), /obsolete/u)
      f.ports.workspace.reopenGeneration = reopen
      await assert.rejects(read(g1), /obsolete/u)
      await assert.rejects(read(g2), /obsolete/u)
      f.ports.journal.fail(f.source, 'concurrent', 'synthetic_failed_refresh')
      await assert.rejects(read(g2), /unavailable/u)
    } finally { f.close() }
  })
}

for (const legacy of [false, true]) {
  test(`${legacy ? 'legacy54 sequence zero' : 'V2 unchanged event high-water'} cannot resume changed non-event rows`, async () => {
    const f = await engineFixture({ messages: 4, legacy })
    try {
      const first = await capture(f)
      const sequence = first.watermark.sequence
      if (legacy) assert.equal(sequence, 0)
      f.writer.prepare("UPDATE projection_projects SET title = 'new project title'").run()
      await assert.rejects(resume(f, first.generation), /snapshot_changed_requires_refresh/u)
      const next = await capture(f)
      assert.equal(next.watermark.sequence, sequence)
      assert.notEqual(next.generation, first.generation)
      await resume(f, next.generation)
    } finally { f.close() }
  })
}

for (const mutation of ["UPDATE projection_thread_messages SET text = 'changed legacy text' WHERE message_id = 'message:0'",
  "DELETE FROM projection_thread_messages WHERE message_id = 'message:0'"]) {
  test(`V2 frozen-copy refresh refuses ${mutation.startsWith('UPDATE') ? 'editing' : 'deleting'} a prior message`, async () => {
    const f = await engineFixture({ messages: 4 })
    try {
      const first = await capture(f)
      f.writer.exec(mutation)
      await assert.rejects(resume(f, first.generation), /snapshot_changed_requires_refresh/u)
      await assert.rejects(capture(f), /frozen_legacy_diverged/u)
    } finally { f.close() }
  })
}

for (const legacy of [false, true]) {
  for (const [id, at] of [['backdated', '2019-01-01T00:00:00.000Z'],
    ['aaa:equal-time', '2020-01-01T00:00:00.000Z'], ['append', '2021-01-01T00:00:00.000Z']]) {
    test(`${legacy ? 'legacy54 fresh hydration preserves' : 'V2 frozen-copy refresh refuses'} ${id} insertion`, async () => {
      const f = await engineFixture({ messages: 4, legacy })
      try {
        const first = await capture(f)
        f.writer.prepare(`INSERT INTO projection_thread_messages
          (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES (?, ?, 'user', ?, 0, ?, ?)`)
          .run(id, f.ids[0], `ordinary ${id}`, at, at)
        await assert.rejects(resume(f, first.generation), /snapshot_changed_requires_refresh/u)
        if (!legacy) {
          await assert.rejects(capture(f), /frozen_legacy_diverged/u)
          // A failed refresh cannot discard the frozen baseline on the next try.
          await assert.rejects(capture(f), /frozen_legacy_diverged/u)
          assert.equal(f.ports.journal.root(f.source.physicalRootKey).available, 0)
        } else {
          const next = await capture(f)
          const full = await readRetainedProjection(...args(f, next.generation))
          const expected = f.writer.prepare(`SELECT message_id, text, created_at FROM projection_thread_messages
            WHERE thread_id = ? ORDER BY created_at, message_id`).all(f.ids[0])
          assert.deepEqual(full.messages.map(row => ({ id: row.id, text: row.text, at: DateTime.formatIso(row.createdAt) })),
            expected.map(row => ({ id: row.message_id, text: row.text, at: row.created_at })))
          assert.equal(full.messages.length, 5)
          const destination = new DatabaseSync(f.destination(next.generation), { readOnly: true })
          try {
            const positions = destination.prepare(`SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions
              WHERE thread_id = ? ORDER BY ordinal`).all(f.ids[0])
            assert.deepEqual(positions.map(row => ({ ...row })), expected.map((row, index) => ({
              turn_item_id: `migration:v1:turn-item:${row.message_id}`, ordinal: index + 1,
            })))
          } finally { destination.close() }
          await resume(f, next.generation)
        }
      } finally { f.close() }
    })
  }
}
