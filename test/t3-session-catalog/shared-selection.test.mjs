import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Effect from 'effect/Effect'
import * as DateTime from 'effect/DateTime'
import { captureRetainedT3 } from '../../dist/t3-session/import/capture.js'
import { createRetainedCatalogService } from '../../dist/t3-session/catalog/service.js'
import { catalogFixture, grantCatalogFixture } from './fixture.mjs'
import { engineFixture } from '../t3-session-import/engine-fixture.mjs'

const shell = service => service.http.shellSnapshot({ params: undefined,
  query: { omitOlderSettled: '1', omitIdleSubagents: '1' } })
const before = { settledAt: '2026-01-01T00:00:00.000Z' }
const grant = threadIds => ({ basis: 'prospective-import-grant', revision: 'synthetic:grant:revision:1',
  scope: 'threads', threadIds, projectIds: ['project:missing'] })

test('shared selector scopes before original tie cursor/count/LIMIT and retains opaque order', async () => {
  const f = await catalogFixture({ threads: 85, messages: 0 })
  try {
    const allowed = f.ids.filter((_id, index) => index > 2 && index % 3 === 0)
    allowed.push(...f.ids.slice(-2).filter(id => !allowed.includes(id)))
    grantCatalogFixture(f, grant(allowed))
    f.ports.journal.catalog = () => { throw new Error('shared read enumerated hidden identities') }
    const lookup = f.ports.journal.catalogIdentity.bind(f.ports.journal)
    f.ports.journal.catalogIdentity = (root, id) => {
      assert.ok(allowed.includes(id), 'shared read probed an ungranted identity')
      return lookup(root, id)
    }
    const first = await Effect.runPromise(shell(f.service))
    assert.deepEqual(new Set(first.value.threads.map(row => row.id)), new Set(allowed))
    assert.equal(first.value.olderSettled.counts.length, 0, 'hidden rows cannot change cutoff/count chips')
    const counts = await Effect.runPromise(f.service.rpc['orchestration.getOlderSettledThreads']({ before, limit: 0 }))
    assert.equal(counts.value.counts.reduce((sum, row) => sum + row.count, 0), allowed.length)
    const seen = []
    let cursor = before
    for (let page = 0; ; page++) {
      assert.ok(page < 20)
      const { value } = await Effect.runPromise(f.service.rpc['orchestration.getOlderSettledThreads']({
        before: cursor, limit: 3,
      }))
      if (!value.threads.length) break
      for (const row of value.threads) { assert.ok(allowed.includes(row.id)); assert.ok(!seen.includes(row.id)); seen.push(row.id) }
      const last = value.threads.at(-1)
      cursor = { settledAt: DateTime.formatIso(last.settledAt), threadId: last.id }
    }
    // SQLite's original byte order differs from JS UTF-16 order for these IDs.
    const expected = [...allowed].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    assert.deepEqual(seen, expected)
    for (const id of [f.ids[0], 'unknown:opaque']) {
      await assert.rejects(Effect.runPromise(f.service.rpc['orchestration.getThreadTitles']({ threadIds: [id] })),
        /capture_read_forbidden/u)
      await assert.rejects(Effect.runPromise(f.service.rpc['orchestration.getThreadFamily']({ threadId: id })),
        /capture_read_forbidden/u)
    }
  } finally { f.close() }
})

test('no published selections expose no thread/project identities or global counts', async () => {
  const f = await catalogFixture({ threads: 60, messages: 0 })
  try {
    grantCatalogFixture(f, { ...grant([]), projectIds: [] })
    f.ports.journal.catalog = () => { throw new Error('empty grant enumerated the catalog') }
    f.ports.journal.catalogIdentity = () => { throw new Error('empty grant probed a thread') }
    const { value } = await Effect.runPromise(shell(f.service))
    assert.deepEqual(value.threads, [])
    assert.deepEqual(value.projects, [])
    assert.deepEqual(value.olderSettled.counts, [])
    const archive = await Effect.runPromise(f.service.rpc['orchestration.getArchivedShellSnapshot']({}))
    assert.deepEqual(archive.value.threads, [])
    assert.deepEqual(archive.value.projects, [])
    const older = await Effect.runPromise(f.service.rpc['orchestration.getOlderSettledThreads']({ before, limit: 0 }))
    assert.deepEqual(older.value.counts, [])
  } finally { f.close() }
})

test('shared archive and family use only selected original rows and explicitly granted projects', async () => {
  const f = await engineFixture({ messages: 0 })
  try {
    f.writer.prepare(`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('hidden:project', 'HIDDEN PROJECT CANARY', '/hidden', '[]', ?, ?)`)
      .run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
    const template = f.writer.prepare('SELECT * FROM orchestration_v2_projection_threads WHERE thread_id = ?').get(f.ids[0])
    const base = JSON.parse(template.payload_json)
    const columns = Object.keys(template)
    const insert = f.writer.prepare(`INSERT INTO orchestration_v2_projection_threads
      (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    for (const id of ['shared:child', 'hidden:child']) {
      const payload = { ...base, id, historyOrigin: 'native', lineage: {
        parentThreadId: f.ids[0], rootThreadId: f.ids[0], relationshipToParent: 'subagent',
      } }
      const row = { ...template, thread_id: id, payload_json: JSON.stringify(payload) }
      insert.run(...columns.map(column => row[column]))
    }
    const capture = await captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
    grantCatalogFixture(f, grant([f.ids[0], f.ids[1], 'shared:child']))
    const service = createRetainedCatalogService(f.ports, { manifest: f.manifest, ...f.source, generation: capture.generation })
    const family = await Effect.runPromise(service.rpc['orchestration.getThreadFamily']({ threadId: f.ids[0] }))
    assert.deepEqual(new Set(family.value.threads.map(row => row.id)), new Set([f.ids[0], 'shared:child']))
    const archive = await Effect.runPromise(service.rpc['orchestration.getArchivedShellSnapshot']({}))
    assert.deepEqual(archive.value.threads.map(row => row.id), [f.ids[1]])
    assert.deepEqual(archive.value.projects.map(row => row.id), ['project:missing'])
    const active = await Effect.runPromise(shell(service))
    assert.deepEqual(active.value.projects.map(row => row.id), ['project:missing'])
    assert.equal(JSON.stringify(active).includes('HIDDEN PROJECT CANARY'), false)
  } finally { f.close() }
})

test('selection revocation or revision change during a read rejects the result', async () => {
  const f = await catalogFixture({ messages: 0 })
  try {
    let revision = 1
    f.ports.catalogAuthority = { withCatalogReadScope: async (_input, use) => {
      const admitted = revision
      return use({ selection: grant([f.ids[0]]), recheckSource: async () => {}, recheckThread: async () => {},
        recheckSelection: async () => { assert.equal(revision, admitted, 'synthetic selection revoked or replaced') } })
    } }
    const reopen = f.ports.workspace.reopenGeneration
    f.ports.workspace.reopenGeneration = async ref => { const stage = await reopen(ref); revision++; return stage }
    await assert.rejects(Effect.runPromise(shell(f.service)), /synthetic selection revoked or replaced/u)
  } finally { f.close() }
})

test('explicit full selection preserves original unfiltered trims, counts and ordering', async () => {
  const f = await engineFixture({ threads: 65, messages: 0 })
  try {
    const update = f.writer.prepare('UPDATE orchestration_v2_projection_threads SET payload_json = ? WHERE thread_id = ?')
    for (const [index, id] of f.ids.entries()) {
      const row = f.writer.prepare('SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ?').get(id)
      const payload = JSON.parse(row.payload_json)
      payload.settledAt = `2020-01-${String(1 + Math.floor(index / 3)).padStart(2, '0')}T00:00:00.000Z`
      if (index === 6 || index === 7) payload.lineage = {
        parentThreadId: f.ids[0], rootThreadId: f.ids[0], relationshipToParent: 'subagent',
      }
      update.run(JSON.stringify(payload), id)
    }
    const capture = await captureRetainedT3(f.ports, f.manifest, f.source.admittedRootKey)
    const service = createRetainedCatalogService(f.ports, { manifest: f.manifest, ...f.source, generation: capture.generation })
    for (const omitIdleSubagents of ['0', '1']) {
      for (const omitOlderSettled of ['0', '1']) {
        const input = { params: undefined, query: { omitIdleSubagents, omitOlderSettled } }
        grantCatalogFixture(f)
        const full = await Effect.runPromise(service.http.shellSnapshot(input))
        grantCatalogFixture(f, grant(f.ids.filter(id => id !== f.ids[2])))
        const subset = await Effect.runPromise(service.http.shellSnapshot(input))
        assert.deepEqual(subset.value, full.value)
        if (omitOlderSettled === '1') {
          assert.ok(full.value.olderSettled.counts.reduce((sum, row) => sum + row.count, 0) > 0)
        }
      }
    }
    const countsInput = { before, limit: 0, projectIds: ['project:missing'] }
    grantCatalogFixture(f)
    const fullCounts = await Effect.runPromise(service.rpc['orchestration.getOlderSettledThreads'](countsInput))
    grantCatalogFixture(f, grant(f.ids.filter(id => id !== f.ids[2])))
    const sharedCounts = await Effect.runPromise(service.rpc['orchestration.getOlderSettledThreads'](countsInput))
    assert.deepEqual(sharedCounts.value, fullCounts.value)
    const excluded = await Effect.runPromise(service.rpc['orchestration.getOlderSettledThreads']({
      ...countsInput, projectIds: ['unselected:project'],
    }))
    assert.deepEqual(excluded.value.counts, [])
  } finally { f.close() }
})
