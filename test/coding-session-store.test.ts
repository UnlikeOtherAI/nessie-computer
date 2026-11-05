import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  encodeEventCursor,
  EVENT_LINE_MAX_BYTES,
  fitEventLine,
  openEventLog,
  parseEventCursor,
  readEventPage,
} from '../src/coding-session/session-events.js'
import { ensureCodingSessionHost } from '../src/coding-session/host-spawn.js'
import {
  codingSessionPaths,
  createDebouncedJsonWriter,
  readJsonFile,
  writeJsonAtomic,
  type CodingSessionPaths,
} from '../src/coding-session/session-files.js'
import { acquireHostLock, hostLockIsStale, readHostLock } from '../src/coding-session/session-lock.js'
import { claimCommand, listRequests, writeRequest } from '../src/coding-session/session-requests.js'
import { CODING_STATUS_MAX_BYTES, composeCodingStatus, deriveCodingStatus } from '../src/coding-session/status.js'
import { initialCodingSessionState, type CodingSessionMeta } from '../src/coding-session/types.js'
import { alive, waitUntil } from './coding-session-harness.js'

const SESSION = '0f0e0d0c-0b0a-4908-8706-050403020100'

const scratch = async (): Promise<{ dir: string; paths: CodingSessionPaths }> => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-coding-store-'))
  const paths = codingSessionPaths(dir, SESSION)
  await mkdir(paths.inbox, { recursive: true })
  return { dir, paths }
}

const meta: CodingSessionMeta = {
  version: 1, sessionId: SESSION, ownerKey: 'owner-a-0123456789', agent: 'claude', rootName: 'work', path: '.', // gitleaks:allow -- synthetic test value, never a credential
  title: 'Task', createdAt: '2026-09-22T00:00:00.000Z',
}

test('a session id is only ever one we minted', () => {
  assert.throws(() => codingSessionPaths('/state', '../../etc'), /lowercase UUID/u)
  assert.throws(() => codingSessionPaths('/state', SESSION.toUpperCase()), /lowercase UUID/u)
})

test('readers take only whole lines, resume exactly at their cursor, and learn when events rotated', async () => {
  const { dir, paths } = await scratch()
  try {
    let position = { generation: 0, lastSeq: 0 }
    const log = await openEventLog(paths, position, (next) => { position = next }, 400)
    for (let index = 0; index < 3; index += 1) await log.append({ kind: 'assistant', text: `message ${index}` })
    // A line the host is half way through writing is neither parsed nor skipped.
    await appendFile(paths.events, '{"seq":4,"kind":"assis')
    const first = await readEventPage(paths, position.generation, undefined, { maxBytes: 65_536, maxEvents: 2 })
    assert.deepEqual(first.events.map((event) => event.seq), [1, 2])
    assert.equal(first.more, true)
    const rest = await readEventPage(paths, position.generation, first.next, { maxBytes: 65_536, maxEvents: 10 })
    assert.deepEqual(rest.events.map((event) => event.seq), [3])
    assert.deepEqual(parseEventCursor(encodeEventCursor(rest.next)), rest.next)
    await appendFile(paths.events, 'tant","text":"late","at":"x"}\n')
    const late = await readEventPage(paths, position.generation, rest.next, { maxBytes: 65_536, maxEvents: 10 })
    assert.deepEqual(late.events.map((event) => event.seq), [4])
    await log.close()
    const reopened = await openEventLog(paths, { generation: 0, lastSeq: 4 }, (next) => { position = next }, 400)
    for (let index = 0; index < 6; index += 1) await reopened.append({ kind: 'assistant', text: `rotating ${index}` })
    await reopened.close()
    assert.ok(position.generation >= 1)
    const after = await readEventPage(paths, position.generation, late.next, { maxBytes: 65_536, maxEvents: 50 })
    assert.equal(after.rotated, true)
    assert.ok(after.events.every((event) => event.seq > 4))
    assert.deepEqual(parseEventCursor('1.2'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a host lock is live only while its heartbeat is fresh, and a stale one is taken over', async () => {
  const { dir, paths } = await scratch()
  try {
    const first = await acquireHostLock(paths.lock, 'sha256:a')
    assert.ok(first)
    assert.equal(await acquireHostLock(paths.lock, 'sha256:a'), undefined, 'a second host is refused')
    assert.equal(await first.heartbeat(), true)
    const record = (await readHostLock(paths.lock))!
    assert.equal(hostLockIsStale(record), false)
    assert.equal(hostLockIsStale(record, Date.now() + 11_000), true)
    // A pid that is alive does not make an old heartbeat fresh: pids get reused.
    await writeJsonAtomic(paths.lock, { ...record, heartbeatAt: new Date(Date.now() - 60_000).toISOString() })
    const second = await acquireHostLock(paths.lock, 'sha256:b')
    assert.ok(second, 'a stale lock is taken over')
    assert.equal(await first.stillOurs(), false)
    assert.equal(await first.heartbeat(), false, 'the old host learns on its next heartbeat')
    await first.release()
    assert.equal((await readHostLock(paths.lock))?.token, second.record.token, 'releasing someone else\'s lock does nothing')
    await second.release()
    assert.equal(await readHostLock(paths.lock), undefined)
    assert.deepEqual((await readdir(paths.dir)).filter((name) => name.includes('.stale.')), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a request lands once under its command id, and a command outcome is recorded once', async () => {
  const { dir, paths } = await scratch()
  try {
    await mkdir(join(dir, 'commands'))
    assert.equal(await writeRequest(paths, { id: 'cmd-1', kind: 'send', text: 'a', at: '2026-09-22T00:00:02.000Z' }), true)
    assert.equal(await writeRequest(paths, { id: 'cmd-1', kind: 'send', text: 'b', at: '2026-09-22T00:00:03.000Z' }), false)
    await writeRequest(paths, { id: 'cmd-0', kind: 'start', text: 'first', at: '2026-09-22T00:00:01.000Z' })
    await writeFile(join(paths.inbox, 'junk.json'), 'not json')
    await writeFile(join(paths.inbox, 'fresh.json'), '{"half":')
    const old = new Date(Date.now() - 60_000)
    await utimes(join(paths.inbox, 'junk.json'), old, old)
    assert.deepEqual((await listRequests(paths)).map((request) => [request.id, request.text]), [['cmd-0', 'first'], ['cmd-1', 'a']])
    assert.equal((await readdir(paths.inbox)).includes('junk.json'), false, 'old junk is cleared')
    assert.equal((await readdir(paths.inbox)).includes('fresh.json'), true, 'a read that failed a moment ago is retried, not deleted')
    const record = { commandId: 'cmd-9', ownerKey: 'o', tool: 'session_start', sessionId: SESSION, at: 'now' }
    assert.equal(await claimCommand(dir, record), undefined)
    assert.deepEqual(await claimCommand(dir, { ...record, sessionId: 'other' }), record)
    await assert.rejects(claimCommand(dir, { ...record, commandId: '../x' }), /command id/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('status is derived at read time and fits 8 KB with status and nextCursor first', async () => {
  const { dir, paths } = await scratch()
  try {
    let position = { generation: 0, lastSeq: 0 }
    const log = await openEventLog(paths, position, (next) => { position = next })
    for (let index = 0; index < 40; index += 1) {
      await log.append({ kind: 'tool', name: index % 2 ? 'Edit' : 'Bash', summary: `step ${index} ${'x'.repeat(250)}` })
    }
    await log.close()
    const state = {
      ...initialCodingSessionState('2026-09-22T00:00:00.000Z'), status: 'working' as const, turn: 1, ...position,
    }
    await writeJsonAtomic(paths.state, state)
    const lost = await deriveCodingStatus(paths, state)
    assert.deepEqual([lost.status, lost.reason], ['interrupted', 'host_lost'], 'working with no heartbeat means the host is gone')
    const held = await acquireHostLock(paths.lock, 'sha256:a')
    const live = await deriveCodingStatus(paths, state)
    assert.equal(live.status, 'working')
    const events = await composeCodingStatus({ paths, meta, state, derived: live, detail: 'events' })
    const text = JSON.stringify(events)
    assert.ok(Buffer.byteLength(text) <= CODING_STATUS_MAX_BYTES, `${Buffer.byteLength(text)} bytes`)
    assert.deepEqual(Object.keys(events).slice(0, 2), ['status', 'nextCursor'])
    assert.equal(events.moreEvents, true)
    const delivered = JSON.parse(await readFile(paths.delivered, 'utf8')) as { cursor: string }
    assert.equal(delivered.cursor, events.nextCursor, 'the bridge remembers what it delivered')
    const summary = await composeCodingStatus({ paths, meta, state, derived: live, detail: 'summary' })
    const counts = (summary.summary as {
      lastTool?: { name: string; summary: string }; newEvents: number; toolCounts: Record<string, number>
    })
    assert.equal(counts.newEvents, 40 - (events.events as unknown[]).length, 'a summary picks up where the last read stopped')
    // What the agent is doing now: its latest tool call, as projected.
    assert.equal(counts.lastTool?.name, 'Edit')
    assert.match(counts.lastTool?.summary ?? '', /^step 39 /)
    const quiet = await composeCodingStatus({ paths, meta, state, derived: live, detail: 'summary' })
    assert.equal((quiet.summary as { newEvents: number }).newEvents, 0)
    assert.ok(Buffer.byteLength(JSON.stringify(quiet)) < 600, 'a poll with nothing new stays small')
    await held?.release()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an event is capped when it is written, whatever escaping and Czech text do to its size', () => {
  const text = 'Příliš žluťoučký kůň úpěl ďábelské ódy. "Uvozovky"\n'.repeat(80).slice(0, 4_000)
  const denials = Array.from({ length: 20 }, () => ({ tool: 'Bash', summary: `git push --force ${'ř'.repeat(280)}` }))
  const event = { seq: 7, at: '2026-09-23T00:00:00.000Z', kind: 'result', text, isError: false, subtype: 'success', permissionDenials: denials } as const
  const line = fitEventLine(event)
  assert.ok(Buffer.byteLength(line) <= EVENT_LINE_MAX_BYTES, `${Buffer.byteLength(line)} bytes`)
  const parsed = JSON.parse(line) as { seq: number; kind: string; subtype: string; text: string }
  assert.deepEqual([parsed.seq, parsed.kind, parsed.subtype], [7, 'result', 'success'])
  assert.ok(parsed.text.startsWith('Příliš žluťoučký'))
  const small = { seq: 8, at: 'x', kind: 'assistant', text: 'short' } as const
  assert.equal(fitEventLine(small), `${JSON.stringify(small)}\n`)
})

test('a line longer than the read window is skipped whole instead of stalling every read', async () => {
  const { dir, paths } = await scratch()
  try {
    await writeFile(paths.events, `${JSON.stringify({ seq: 1, at: 'x', kind: 'assistant', text: 'z'.repeat(20_000) })}\n`)
    await appendFile(paths.events, `${JSON.stringify({ seq: 2, at: 'x', kind: 'assistant', text: 'after' })}\n`)
    const first = await readEventPage(paths, 0, undefined, { maxBytes: 7 * 1024, maxEvents: 200 })
    assert.deepEqual([first.events.length, first.skipped, first.more], [0, true, true])
    const second = await readEventPage(paths, 0, first.next, { maxBytes: 7 * 1024, maxEvents: 200 })
    assert.deepEqual(second.events.map((event) => event.seq), [2])
    // A long line still being written (no newline yet) is waited for, not skipped.
    await appendFile(paths.events, JSON.stringify({ seq: 3, at: 'x', kind: 'assistant', text: 'y'.repeat(20_000) }))
    const partial = await readEventPage(paths, 0, second.next, { maxBytes: 7 * 1024, maxEvents: 200 })
    assert.deepEqual([partial.events.length, partial.skipped, partial.next.offset], [0, false, second.next.offset])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('status in events mode always moves its cursor, even past big events and a long final result', async () => {
  const { dir, paths } = await scratch()
  try {
    let position = { generation: 0, lastSeq: 0 }
    const log = await openEventLog(paths, position, (next) => { position = next })
    for (let index = 0; index < 6; index += 1) {
      await log.append({ kind: 'assistant', text: `${index} ${'č"\n'.repeat(1_500)}` })
    }
    await log.close()
    const lastResult = { text: 'ř"'.repeat(2_000), isError: false, subtype: 'success', permissionDenials: [] }
    const state = { ...initialCodingSessionState('2026-09-22T00:00:00.000Z'), status: 'waiting_for_input' as const, lastResult, ...position }
    const derived = await deriveCodingStatus(paths, state)
    const seen: number[] = []
    for (let poll = 0; poll < 12 && seen.length < 6; poll += 1) {
      const answer = await composeCodingStatus({ paths, meta, state, derived, detail: 'events' })
      assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= CODING_STATUS_MAX_BYTES)
      const events = answer.events as { seq: number }[]
      assert.ok(events.length > 0, `poll ${poll} delivered nothing`)
      seen.push(...events.map((event) => event.seq))
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hosts that die before serving stop being started, and the session says why', { timeout: 60_000 }, async () => {
  const { dir, paths } = await scratch()
  try {
    const entry = join(dir, 'crashing-host.mjs')
    await writeFile(entry, 'process.exit(1)\n')
    await writeRequest(paths, { id: 'cmd-start', kind: 'start', text: 'x', at: new Date().toISOString() })
    const input = { configPath: join(dir, 'c.json'), entry, paths, sessionId: SESSION }
    const options = { userManager: () => undefined }
    // Each spawn window is 15 s; the marker is aged instead of waiting it out, once the crashed host has gone
    // (a host whose process still runs is waited for, however old its marker).
    const age = async () => {
      const marker = JSON.parse(await readFile(paths.spawnMarker, 'utf8')) as Record<string, unknown>
      if (typeof marker.pid === 'number') {
        await waitUntil(async () => (alive(marker.pid as number) ? undefined : true), 20_000, 'the crashed host to exit')
      }
      await writeJsonAtomic(paths.spawnMarker, { ...marker, at: Date.now() - 20_000 })
    }
    assert.equal(await ensureCodingSessionHost(input, options), 'spawned')
    assert.equal((await deriveCodingStatus(paths, undefined)).status, 'starting')
    assert.equal(await ensureCodingSessionHost(input, options), 'starting', 'no second host inside the window')
    for (const expected of ['spawned', 'spawned', 'failed'] as const) {
      await age()
      assert.equal(await ensureCodingSessionHost(input, options), expected)
    }
    const derived = await deriveCodingStatus(paths, undefined)
    assert.deepEqual([derived.status, derived.reason], ['failed', 'host_failed_to_start'], 'not "starting" for ever')
    const resumable = await deriveCodingStatus(paths, { ...initialCodingSessionState('x'), status: 'interrupted', turn: 2 })
    assert.deepEqual([resumable.status, resumable.reason], ['interrupted', 'host_failed_to_start'])
    assert.equal(await ensureCodingSessionHost(input, { ...options, fresh: true }), 'spawned', 'a new request tries again')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('a host that is slow to start is waited for, in its unit or detached, not started a second time', {
  timeout: 60_000,
}, async () => {
  const { dir, paths } = await scratch()
  const started: number[] = []
  try {
    // A host still loading the executor on a busy machine: alive, not yet holding the lock.
    const entry = join(dir, 'slow-host.mjs')
    await writeFile(entry, 'setTimeout(() => {}, 60_000)\n')
    await writeRequest(paths, { id: 'cmd-start', kind: 'start', text: 'x', at: new Date().toISOString() })
    const input = { configPath: join(dir, 'c.json'), entry, paths, sessionId: SESSION }
    // This systemd-run starts the host itself, and systemctl names it as the unit's main process.
    const unit = {
      userManager: () => ({ environment: {} }),
      runUnit: async (file: string) => {
        if (file === 'systemd-run') {
          const host = spawn(process.execPath, [entry], { stdio: 'ignore' })
          started.push(host.pid!)
          return { status: 'ok' as const, stdout: '' }
        }
        return { status: 'ok' as const, stdout: `${started.at(-1)}\n` }
      },
    }
    for (const [supervisor, options] of [['detached', { userManager: () => undefined }], ['unit', unit]] as const) {
      await rm(paths.spawnMarker, { force: true })
      assert.equal(await ensureCodingSessionHost(input, options), 'spawned', supervisor)
      const marker = JSON.parse(await readFile(paths.spawnMarker, 'utf8')) as Record<string, unknown>
      assert.equal(typeof marker.pid, 'number', `${supervisor}: the host's process is recorded`)
      started.push(marker.pid as number)
      // Past the grace, the process that is still running keeps the session starting.
      await writeJsonAtomic(paths.spawnMarker, { ...marker, at: Date.now() - 20_000 })
      assert.equal(await ensureCodingSessionHost(input, options), 'starting', supervisor)
      assert.equal((await deriveCodingStatus(paths, undefined)).status, 'starting', supervisor)
      // Once it has gone without taking the lock, the next request starts another.
      process.kill(marker.pid as number, 'SIGKILL')
      await waitUntil(async () => (alive(marker.pid as number) ? undefined : true), 10_000, 'the slow host to exit')
      assert.equal(await ensureCodingSessionHost(input, options), 'spawned', supervisor)
      const next = JSON.parse(await readFile(paths.spawnMarker, 'utf8')) as Record<string, unknown>
      started.push(next.pid as number)
    }
  } finally {
    for (const pid of started) if (alive(pid)) process.kill(pid, 'SIGKILL')
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test('a file that exists but cannot be read is not taken for a missing one', async () => {
  const { dir, paths } = await scratch()
  try {
    assert.deepEqual(await readJsonFile(join(dir, 'absent.json')), { found: 'no' })
    await writeFile(paths.state, '{"half":')
    assert.deepEqual(await readJsonFile(paths.state), { found: 'unreadable' })
    await writeFile(paths.state, '{"version":1}')
    assert.deepEqual(await readJsonFile(paths.state), { found: 'yes', value: { version: 1 } })
    // A host whose lock is gone writes nothing more.
    const target = join(dir, 'guarded.json')
    const writer = createDebouncedJsonWriter(target, () => ({ status: 'working' }), () => undefined, 500, async () => false)
    await writer.flush()
    assert.deepEqual(await readJsonFile(target), { found: 'no' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
