import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { ExecutorCodingSessionSummarySchema } from '@nessie/executor-protocol'

import {
  CODING_SESSIONS_CONFIG_DIGEST_ENV,
  codingSessionsConfigDigest,
  normalizeCodingSessionsConfig,
} from '../src/coding-session/config.js'
import { createCodingSessionsDaemon } from '../src/coding-sessions-daemon.js'
import { newLocalCommandPolicy } from '../src/command-policy.js'
import { codingSessionsFacts } from '../src/coding-sessions-policy.js'
import { createCodingHarness, type CodingHarness } from './coding-session-harness.js'

/**
 * The daemon's teardown and report against a real bridge: a heartbeat's
 * `codingSessionClose` for one owner closes that owner's sessions and leaves
 * everyone else's running, a close naming one session closes only it, and the
 * report lists open sessions by title and owner with nothing they said.
 */

const OWNER_A = `sha256:${'a'.repeat(64)}`
const OWNER_B = `sha256:${'b'.repeat(64)}`

const daemonFor = async (harness: CodingHarness) => {
  const config = normalizeCodingSessionsConfig(JSON.parse(await readFile(harness.configPath, 'utf8')))
  const digest = codingSessionsConfigDigest(config)
  return createCodingSessionsDaemon({
    executorId: '00000000-0000-4000-8000-000000000901',
    commandRules: newLocalCommandPolicy,
    facts: codingSessionsFacts(config, digest),
    // The harness started this same bridge; the daemon needs only its name and its reviewed digest.
    servers: [{
      name: 'coding-sessions',
      command: [process.execPath, 'index.ts', 'serve-coding-session-mcp', '--config', harness.configPath],
      env: { [CODING_SESSIONS_CONFIG_DIGEST_ENV]: digest },
    }],
    sessions: harness.manager,
  })
}

test('a heartbeat close ends one owner\'s sessions, or one session, and the report says what is open', {
  timeout: 180_000,
}, async () => {
  const harness = await createCodingHarness({ reviewedDigest: true })
  try {
    const daemon = await daemonFor(harness)
    const start = async (owner: string, prompt: string) => {
      const started = await harness.call('session_start', { agent: 'claude', root: 'work', prompt }, { owner })
      const sessionId = started.body.sessionId as string
      await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input', owner)
      return sessionId
    }
    const a1 = await start(OWNER_A, 'Fix the flaky login test\nthen open a PR')
    const a2 = await start(OWNER_A, 'Upgrade the lint config')
    const b1 = await start(OWNER_B, 'Owner B work')

    const report = await daemon.report()
    assert.deepEqual(new Set(report?.map((session) => session.sessionId)), new Set([a1, a2, b1]))
    for (const session of report ?? []) {
      assert.equal(ExecutorCodingSessionSummarySchema.safeParse(session).success, true)
    }
    assert.deepEqual(report?.find((session) => session.sessionId === a1), {
      ...report?.find((session) => session.sessionId === a1),
      ownerKey: OWNER_A, title: 'Fix the flaky login test', agent: 'claude', root: 'work', status: 'waiting_for_input',
    })
    const listed = await harness.call('session_list_all', {}, { owner: OWNER_A })
    assert.equal(listed.code, 'coding_session_daemon_only', 'a model call cannot read every owner\'s sessions')

    await daemon.close([{ ownerKey: OWNER_A, sessionId: a2, reason: 'closed_by_person' }])
    await harness.waitForStatus(a2, (body) => body.status === 'closed', OWNER_A)
    assert.equal((await harness.call('session_status', { sessionId: a1 }, { owner: OWNER_A })).body.status, 'waiting_for_input')

    await daemon.close([{ ownerKey: OWNER_A, reason: 'lease_ended' }])
    await harness.waitForStatus(a1, (body) => body.status === 'closed', OWNER_A)
    const other = await harness.call('session_status', { sessionId: b1 }, { owner: OWNER_B })
    assert.equal(other.body.status, 'waiting_for_input', 'another owner\'s session keeps running')
    const after = await daemon.report()
    assert.deepEqual(after?.map((session) => session.sessionId), [b1], 'closed sessions leave the report')

    // A title the path rewrite lengthens past the report's limit is clipped, not dropped from the report.
    const titled = await harness.call('session_start', {
      agent: 'claude', root: 'work', prompt: 'titled', title: `${'x'.repeat(112)} /tmp/a`,
    }, { owner: OWNER_B })
    const titledId = titled.body.sessionId as string
    await harness.waitForStatus(titledId, (body) => body.status === 'waiting_for_input', OWNER_B)
    const entry = (await daemon.report())?.find((session) => session.sessionId === titledId)
    assert.ok(entry, 'still reported, so a person can still close it')
    assert.equal(entry.title.length, 120)
    assert.ok(entry.title.endsWith('…'))
  } finally {
    await harness.cleanup()
  }
})

test('the report states each session\'s turn, when its last turn ended and what it has cost', {
  timeout: 150_000,
}, async () => {
  const harness = await createCodingHarness({ reviewedDigest: true })
  try {
    const daemon = await daemonFor(harness)
    const reported = async (sessionId: string) => {
      const entry = (await daemon.report())?.find((session) => session.sessionId === sessionId)
      assert.ok(entry, 'the daemon kept the entry, so its schema accepts both fields')
      return entry
    }
    const startCommand = randomUUID()
    const started = await harness.call('session_start', {
      agent: 'claude', root: 'work', prompt: '#hold=first the first turn',
    }, { owner: OWNER_A, command: startCommand })
    const sessionId = started.body.sessionId as string
    await harness.waitForStatus(sessionId, (body) => body.status === 'working', OWNER_A)
    const working = await reported(sessionId)
    assert.equal(working.turn, 1)
    assert.equal(working.lastTurnEndedAt, null, 'the first turn is still running, and none has ended')
    assert.equal('totalCostUsd' in working, false, 'no turn has reported a cost yet, so none is stated')

    await harness.release('first')
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input', OWNER_A)
    const first = await reported(sessionId)
    assert.equal(first.turn, 1)
    assert.ok(first.lastTurnEndedAt && Date.parse(first.lastTurnEndedAt) >= Date.parse(working.updatedAt))
    // The same cumulative figure session_status answers, carried through the report unchanged.
    assert.equal(first.totalCostUsd, 0.01)
    const replayedStart = await harness.call('session_start', {
      agent: 'claude', root: 'work', prompt: '#hold=first the first turn',
    }, { owner: OWNER_A, command: startCommand })
    assert.deepEqual([replayedStart.body.replayed, replayedStart.body.totalCostUsd], [true, 0.01])

    // A second turn ends between two reads: the status is the same, and the turn says it moved.
    const sent = await harness.call('session_send', { sessionId, message: 'a second, quick turn' }, { owner: OWNER_A })
    assert.equal(sent.body.totalCostUsd, 0.01, 'the send answer states what the session had cost when it was sent')
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input' && body.turn === 2, OWNER_A)
    const second = await reported(sessionId)
    assert.equal(second.status, first.status)
    assert.equal(second.turn, 2)
    assert.ok(Date.parse(second.lastTurnEndedAt!) > Date.parse(first.lastTurnEndedAt))
    assert.equal(second.totalCostUsd, 0.02, 'the cost is the session\'s across its turns, not the last turn\'s')

    // Codex reports no cost, so neither its report entry nor its answers state one.
    const codex = await harness.call('session_start', {
      agent: 'codex', root: 'work', prompt: 'a codex turn',
    }, { owner: OWNER_A })
    const codexId = codex.body.sessionId as string
    await harness.waitForStatus(codexId, (body) => body.status === 'waiting_for_input', OWNER_A)
    assert.equal('totalCostUsd' in await reported(codexId), false)
    const codexSent = await harness.call('session_send', { sessionId: codexId, message: 'again' }, { owner: OWNER_A })
    assert.equal(codexSent.ok, true, JSON.stringify(codexSent.body))
    assert.equal('totalCostUsd' in codexSent.body, false)
  } finally {
    await harness.cleanup()
  }
})
