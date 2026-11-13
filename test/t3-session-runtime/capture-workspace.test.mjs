import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { withRetainedCaptureWorkspace } from '../../dist/t3-session/runtime/capture-workspace.js'
import { assertOutsideCheckout } from '../../dist/t3-session/runtime/paths.js'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory } from '../../dist/state-security.js'

const fixtureRoot = async () => {
  const root = process.env.T3_RUNTIME_FIXTURE_ROOT
  assert.ok(root, 'T3_RUNTIME_FIXTURE_ROOT must be a dedicated approved private artifact root')
  await assertOutsideCheckout(root)
  await assertOwnerOnlyStatePath(root, 'directory')
  const fixture = await mkdtemp(join(root, 'retained-workspace-'))
  // Exercise SQLite's own WAL/journal suffixes beyond Win32 MAX_PATH as well
  // as Node's opens. Retain both successful and failed generations.
  const directory = join(fixture, 'long-state-directory-'.repeat(5))
  await mkdir(directory)
  await ensureOwnerOnlyStateDirectory(directory)
  return directory
}
const sqlOf = stage => Effect.runPromise(Effect.scoped(SqlClient.SqlClient.pipe(Effect.provide(stage.sql))))

test('actual capture workspace holds one SQL service, preserves bytes across reopen, and retires escaped stages', async () => {
  const root = await fixtureRoot()
  const signal = new AbortController().signal
  let escaped
  let reference
  await withRetainedCaptureWorkspace(root, 'synthetic:physical-root', async storage => {
    const first = await storage.workspace.createGeneration('synthetic:opaque/generation:雪')
    const again = await storage.workspace.reopenGeneration(first.reference)
    reference = first.reference
    escaped = first
    assert.equal(first, again)
    const sql = await sqlOf(first)
    assert.equal(sql, await sqlOf(again))
    await Effect.runPromise(sql`CREATE TABLE runtime_fixture (value TEXT NOT NULL)`)
    await Effect.runPromise(sql`INSERT INTO runtime_fixture (value) VALUES ('preserved')`)
    await assert.rejects(storage.workspace.createGeneration('synthetic:opaque/generation:雪'), /not_fresh/u)
    await assert.rejects(storage.workspace.reopenGeneration('../arbitrary.sqlite'), /reference_invalid/u)
    await assert.rejects(withRetainedCaptureWorkspace(root, 'synthetic:physical-root', async () => {}, signal))
    storage.assertCurrent()
  }, signal)
  await assert.rejects(sqlOf(escaped))
  await withRetainedCaptureWorkspace(root, 'synthetic:physical-root', async storage => {
    const stage = await storage.workspace.reopenGeneration(reference)
    const sql = await sqlOf(stage)
    const rows = await Effect.runPromise(sql`SELECT value FROM runtime_fixture`)
    assert.deepEqual(rows.map(row => ({ ...row })), [{ value: 'preserved' }])
    await assert.rejects(storage.workspace.createGeneration('synthetic:opaque/generation:雪'))
  }, signal)
  // Preserve all fixture files; never delete a journal, stage or writer lock.
})

test('caller cancellation is observable while callback drains, then workspace refuses reuse', async () => {
  const root = await fixtureRoot()
  const caller = new AbortController()
  let escaped
  let drained = false
  await assert.rejects(withRetainedCaptureWorkspace(root, 'synthetic:cancel-root', async storage => {
    escaped = storage
    await storage.workspace.createGeneration('synthetic:cancel-generation')
    caller.abort(new Error('synthetic-stop'))
    assert.equal(storage.signal.aborted, true)
    await Promise.resolve()
    drained = true
  }, caller.signal), /synthetic-stop/u)
  assert.equal(drained, true)
  assert.throws(() => escaped.assertCurrent())
})
