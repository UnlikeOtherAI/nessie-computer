import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, realpath, rename, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixtureRoot, load } from './load-source.mjs'

const { NativeClaudeHistory } = await load('t3-session/native-sources/claude/index')
const { listSavedClaudeSessions } = await load('existing-session/claude-saved')
const { readClaudeRecentMessages } = await load('existing-session/claude-history')
const NATIVE = '11111111-1111-4111-a111-111111111111'
const target = { source: 'claude', admittedRootKey: 'fixture:root' }
const row = (content, extra = {}) => JSON.stringify({ sessionId: NATIVE, type: 'user',
  uuid: randomUUID(), cwd: '/fixture', message: { content }, ...extra }) + '\n'

async function fixture() {
  await mkdir(fixtureRoot, { recursive: true })
  const profile = await realpath(await mkdtemp(join(fixtureRoot, 'claude-')))
  const projectsRoot = join(profile, 'projects')
  await mkdir(join(projectsRoot, 'repo'), { recursive: true })
  let live = true
  let checks = 0
  let historyChecks = 0
  let hook = async () => {}
  const recheck = async () => { checks++; await hook(); if (!live) throw new Error('fixture_revoked') }
  // Synthetic admission tests consumer behavior, not a production authority producer.
  const service = new NativeClaudeHistory({ withReadScope: async (input, use) => {
    assert.equal(input.admittedRootKey, target.admittedRootKey)
    return use({ ...target, physicalRootKey: 'fixture:physical', projectsRoot, recheck,
      recheckHistory: async () => { historyChecks++; await recheck() } })
  } })
  return { profile, projectsRoot, service, file: join(projectsRoot, 'repo', `${NATIVE}.jsonl`),
    revoke: () => { live = false }, setHook: value => { hook = value },
    checks: () => checks, historyChecks: () => historyChecks }
}

test('unbound admission refuses before filesystem access', async () => {
  await assert.rejects(new NativeClaudeHistory().catalog({ target }), /required_unbound/u)
  await assert.rejects(new NativeClaudeHistory().history({ target: { ...target, historyId: 'unknown' } }), /required_unbound/u)
})

test('old, empty, overlay and nested histories survive complete stable source paging', async () => {
  const f = await fixture()
  await writeFile(f.file, row('Starý příběh'))
  await utimes(f.file, new Date(0), new Date(0))
  const empty = randomUUID()
  await writeFile(join(f.projectsRoot, 'repo', `${empty}.jsonl`), '')
  await mkdir(join(f.projectsRoot, 'overlay'), { recursive: true })
  await writeFile(join(f.projectsRoot, 'overlay', `${NATIVE}.jsonl`), row('same native, separate history'))
  const nested = join(f.projectsRoot, 'repo', NATIVE, 'subagents')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, 'agent-child_1.jsonl'), row('nested', { isSidechain: true }))
  const first = await f.service.catalog({ target, limit: 2 })
  assert.equal(first.complete, false)
  assert.equal(first.sourceComplete, true)
  assert.deepEqual(await f.service.catalog({ target, limit: 2 }), first)
  const second = await f.service.catalog({ target, limit: 2, cursor: first.nextCursor })
  assert.equal(second.complete, true)
  const rows = [...first.rows, ...second.rows]
  assert.equal(new Set(rows.map(item => item.historyId)).size, 4)
  assert.equal(rows.filter(item => item.nativeId === NATIVE).length, 3)
  assert.ok(rows.some(item => item.agentId === 'child_1' && item.parentHistoryId))
  assert.ok(rows.every(item => item.control === 'unavailable'))
  assert.equal(JSON.stringify(rows).includes(f.profile), false)
  assert.equal((await listSavedClaudeSessions(f.profile)).length, 3)
})

test('source-bound cursor rejects another root and catalog changes', async () => {
  const f = await fixture()
  await writeFile(f.file, row('one'))
  const page = await f.service.catalog({ target })
  await writeFile(join(f.projectsRoot, 'repo', `${randomUUID()}.jsonl`), '')
  await assert.rejects(f.service.catalog({ target, cursor: { generation: page.generation, offset: 0 } }), /cursor_stale/u)
  await assert.rejects(f.service.catalog({ target, cursor: { generation: 'different-root', offset: 0 } }), /cursor_stale/u)
})

test('full supported history pages preserve Unicode, long text, repeated IDs and original order', async () => {
  const f = await fixture()
  const long = 'Čau 雪\n'.repeat(5000)
  await writeFile(f.file, row(long, { uuid: 'same-native-id' }) + row('druhej', { uuid: 'same-native-id' })
    + row([{ type: 'thinking', thinking: 'reason' }], { type: 'assistant' }))
  const entry = (await f.service.catalog({ target })).rows[0]
  const request = { target: { ...target, historyId: entry.historyId }, limit: 1 }
  const first = await f.service.history(request)
  assert.equal(first.records[0].parts[0].text, long)
  assert.deepEqual(await f.service.history(request), first)
  const second = await f.service.history({ ...request, cursor: first.nextCursor })
  assert.equal(second.records[0].id, first.records[0].id)
  assert.ok(second.records[0].offset > first.records[0].offset)
  const third = await f.service.history({ ...request, cursor: second.nextCursor })
  assert.equal(third.records[0].parts[0].kind, 'thinking')
  assert.equal(third.complete, true)
  assert.equal(third.nextCursor, null)
  assert.ok(f.historyChecks() >= 9)
})

test('native tool values and excluded metadata never enter the supported history projection', async () => {
  const f = await fixture()
  await writeFile(f.file, row([{ type: 'tool_use', id: 'call:1', name: 'request_secret', input: { value: '1234' } }],
    { type: 'assistant', usage: { cost: 'EXCLUDED' } })
    + row([{ type: 'tool_result', tool_use_id: 'call:1', content: '1234' }])
    + JSON.stringify({ type: 'system', account: 'PRIVATE', usage: 'EXCLUDED' }) + '\n')
  const entry = (await f.service.catalog({ target })).rows[0]
  const page = await f.service.history({ target: { ...target, historyId: entry.historyId } })
  assert.equal(page.fidelity, 'partial')
  assert.equal(page.records[0].parts[0].id, 'call:1')
  assert.equal(page.records[1].parts[0].id, 'call:1')
  for (const withheld of ['1234', 'EXCLUDED', 'PRIVATE']) assert.equal(JSON.stringify(page).includes(withheld), false)
})

test('partial final records stay incomplete and append invalidates the snapshot cursor', async () => {
  const f = await fixture()
  await writeFile(f.file, row('first') + '{"sessionId":')
  const entry = (await f.service.catalog({ target })).rows[0]
  const request = { target: { ...target, historyId: entry.historyId } }
  const page = await f.service.history(request)
  assert.equal(page.partialLastRecord, true)
  assert.equal(page.complete, false)
  assert.deepEqual(await f.service.history({ ...request, cursor: page.nextCursor }),
    { ...page, records: [], fidelity: 'supported' })
  await appendFile(f.file, '"other"}\n')
  await assert.rejects(f.service.history({ ...request, cursor: page.nextCursor }), /cursor_stale/u)
})

test('malformed, oversized, wrong-session and mid-record cursors are explicit failures', async () => {
  for (const [body, error] of [['not-json\n', /record_invalid/u], [row('x'.repeat(600_000)), /record_too_large/u],
    [row('wrong', { sessionId: randomUUID() }), /identity_mismatch/u]]) {
    const f = await fixture()
    await writeFile(f.file, body)
    const entry = (await f.service.catalog({ target })).rows[0]
    await assert.rejects(f.service.history({ target: { ...target, historyId: entry.historyId } }), error)
  }
  const f = await fixture()
  await writeFile(f.file, row('valid'))
  const entry = (await f.service.catalog({ target })).rows[0]
  await assert.rejects(f.service.history({ target: { ...target, historyId: entry.historyId },
    cursor: { historyId: entry.historyId, revision: entry.revision, offset: 1 } }), /cursor_invalid/u)
})

test('revocation during catalog and history reads rejects publication', async () => {
  const f = await fixture()
  await writeFile(f.file, row('PRIVATE'))
  const entry = (await f.service.catalog({ target })).rows[0]
  const at = f.checks()
  f.setHook(async () => { if (f.checks() > at + 8) f.revoke() })
  await assert.rejects(f.service.history({ target: { ...target, historyId: entry.historyId } }), /revoked/u)
  await assert.rejects(f.service.catalog({ target }), /revoked/u)
})

test('redirected history is incomplete and cannot be opened by an invented identifier', async () => {
  const f = await fixture()
  const outside = join(f.profile, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, `${NATIVE}.jsonl`), row('OUTSIDE'))
  await symlink(outside, join(f.projectsRoot, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
  const page = await f.service.catalog({ target })
  assert.equal(page.sourceComplete, false)
  assert.equal(page.complete, false)
  await assert.rejects(f.service.history({ target: { ...target, historyId: '../outside' } }), /not_found/u)
})

test('replacement between pages fails and legacy reads never reconstruct a path from cwd', async () => {
  const f = await fixture()
  await writeFile(f.file, row('one') + row('two'))
  const entry = (await f.service.catalog({ target })).rows[0]
  const request = { target: { ...target, historyId: entry.historyId }, limit: 1 }
  const page = await f.service.history(request)
  await rename(f.file, `${f.file}.old`)
  await writeFile(f.file, row('replacement'))
  await assert.rejects(f.service.history({ ...request, cursor: page.nextCursor }), /cursor_stale/u)
  assert.deepEqual(await readClaudeRecentMessages(f.profile, { cwd: '/repo', nativeId: NATIVE }),
    { recentMessages: [], historyAvailable: false })
})
