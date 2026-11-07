import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  EXISTING_CODING_SESSION_OWNER_KEY, ExecutorSessionConversationSchema,
  type ExecutorSessionRequest,
} from '@nessie/executor-protocol'

import { codingSessionPaths } from '../src/coding-session/session-files.js'
import { createCodingHarness, waitUntil, type CodingHarness } from './coding-session-harness.js'

const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms) })

/**
 * Live questions, approvals and secrets, through the real bridge and host,
 * with the scripted agent speaking Claude Code's permission prompts and
 * Codex's app-server requests. Every answer goes the way the daemon sends it:
 * `session_user_action` with an `answer`.
 */

const OWNER = `sha256:${'a'.repeat(64)}`

type Receipt = { id: string; state: string; code: string }

const startSession = async (harness: CodingHarness, agent: 'claude' | 'codex', prompt: string): Promise<string> => {
  const started = await harness.call('session_start', { agent, root: 'work', prompt }, { owner: OWNER })
  assert.equal(started.ok, true, JSON.stringify(started.body))
  return String(started.body.sessionId)
}

const conversation = async (harness: CodingHarness, sessionId: string) => ExecutorSessionConversationSchema.parse(
  (await harness.call('session_conversation', { sessionId, ownerKey: OWNER }, { daemon: true })).body.conversation,
)

const requestWhere = (
  harness: CodingHarness, sessionId: string, accept: (request: ExecutorSessionRequest) => boolean, what: string,
): Promise<ExecutorSessionRequest> => waitUntil(async () => (
  await conversation(harness, sessionId).catch(() => undefined))?.requests?.find(accept), 30_000, what)

const pendingOf = (harness: CodingHarness, sessionId: string, kind?: ExecutorSessionRequest['kind']) => requestWhere(
  harness, sessionId, (request) => request.status === 'pending' && (!kind || request.kind === kind), `a pending ${kind ?? 'request'}`,
)

const act = async (
  harness: CodingHarness, sessionId: string, body: Record<string, unknown>, id: string = randomUUID(),
): Promise<Receipt> => {
  const answer = await harness.call('session_user_action', {
    id, ownerKey: OWNER, sessionId, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...body,
  }, { daemon: true })
  return answer.body.receipt as Receipt
}

const reply = (harness: CodingHarness, sessionId: string, answer: Record<string, unknown>, id?: string) => (
  act(harness, sessionId, { kind: 'answer', answer }, id)
)

const recorded = (harness: CodingHarness, agent: string, event: string) => waitUntil(async () => (
  await harness.agents())
  .find((entry) => entry.agent === agent && entry.event === event), 30_000, `the agent to record ${event}`)

const reportedPending = async (harness: CodingHarness, sessionId: string) => {
  const report = await harness.call('session_list_all', {}, { daemon: true, owner: '' })
  const sessions = report.body.sessions as { sessionId: string; pending?: unknown }[]
  return sessions.find((row) => row.sessionId === sessionId)?.pending
}

test('a Claude permission prompt waits for the owner, is answered once, and stale answers say why', { timeout: 120_000 },
  async () => {
    const harness = await createCodingHarness({ reviewedDigest: true, ownerRequests: true })
    try {
      const sessionId = await startSession(harness, 'claude', '#permit publish it')
      const request = await pendingOf(harness, sessionId, 'command')
      assert.deepEqual({ title: request.title, command: request.command, cwd: request.cwd, decisions: request.decisions,
        answerable: request.answerable, justification: request.justification }, {
        title: 'Run git push --force', command: 'git push --force', cwd: '.', answerable: true,
        decisions: ['accept', 'accept_for_session', 'decline', 'cancel'], justification: 'Publish the branch',
      })
      assert.deepEqual(await reportedPending(harness, sessionId),
        { kind: 'approval', count: 1, answerable: true, since: request.openedAt }, 'a list row learns the kind of wait')
      const shape = await reply(harness, sessionId, { requestId: request.id, answers: [{ questionId: 'q1', values: ['x'] }] })
      assert.deepEqual([shape.state, shape.code], ['failed', 'answer_shape_mismatch'])
      const unknown = await reply(harness, sessionId, { requestId: 'req-unknown', decision: 'accept' })
      assert.deepEqual([unknown.state, unknown.code], ['failed', 'request_not_pending'])
      const first = randomUUID()
      const accepted = await reply(harness, sessionId, { requestId: request.id, decision: 'accept_for_session' }, first)
      assert.deepEqual([accepted.state, accepted.code], ['accepted', 'answer_delivered'])
      const replayed = await reply(harness, sessionId, { requestId: request.id, decision: 'accept_for_session' }, first)
      assert.deepEqual([replayed.state, replayed.code], ['accepted', 'answer_delivered'], 'a retried action reads its first outcome')
      const twice = await reply(harness, sessionId, { requestId: request.id, decision: 'decline' })
      assert.deepEqual([twice.state, twice.code], ['failed', 'request_not_pending'], 'a request is answered once')
      const permission = await recorded(harness, 'claude', 'permission')
      assert.deepEqual(permission.response, {
        behavior: 'allow', updatedInput: { command: 'git push --force', description: 'Publish the branch' },
        updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push --force' }],
          behavior: 'allow', destination: 'session' }],
      }, 'accepting for the session adds Claude\'s own rule for this session only')
      await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input', OWNER)
      const settled = await requestWhere(harness, sessionId, (entry) => entry.id === request.id, 'the settled request')
      assert.equal(settled.status, 'answered')
      assert.equal(await reportedPending(harness, sessionId), undefined)
    } finally {
      await harness.cleanup()
    }
  })

test('a Claude question is answered by its options, and a decline carries the owner\'s feedback', { timeout: 120_000 },
  async () => {
    const harness = await createCodingHarness({ reviewedDigest: true, ownerRequests: true })
    try {
      // The scripted agent asks its permission first, then its question.
      const sessionId = await startSession(harness, 'claude', '#question #permit pick one')
      const permit = await pendingOf(harness, sessionId, 'command')
      const declined = await reply(harness, sessionId, { requestId: permit.id, decision: 'decline',
        feedback: 'Open a pull request instead.' })
      assert.equal(declined.state, 'accepted')
      const permission = await recorded(harness, 'claude', 'permission')
      assert.deepEqual(permission.response, { behavior: 'deny', message: 'Open a pull request instead.' })
      const question = await pendingOf(harness, sessionId, 'question')
      assert.deepEqual(question.questions, [{ id: 'q1', header: 'Database', question: 'Which database?', multiSelect: false,
        allowCustomAnswer: true, secret: false,
        options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite', description: 'One file' }] }])
      assert.deepEqual(question.decisions, ['decline', 'cancel'])
      assert.equal((await reportedPending(harness, sessionId) as { kind: string }).kind, 'question')
      const two = await reply(harness, sessionId, { requestId: question.id, answers: [{ questionId: 'q1', values: ['A', 'B'] }] })
      assert.equal(two.code, 'answer_shape_mismatch', 'a single-choice question takes one answer')
      const answered = await reply(harness, sessionId, { requestId: question.id,
        answers: [{ questionId: 'q1', values: ['SQLite'] }] })
      assert.equal(answered.state, 'accepted')
      const asked = await recorded(harness, 'claude', 'question')
      assert.deepEqual((asked.response as { updatedInput: { answers: unknown } }).updatedInput.answers,
        { 'Which database?': 'SQLite' })
      await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input', OWNER)
    } finally {
      await harness.cleanup()
    }
  })

test('an interrupt cancels what is pending, and a provider that exits expires it', { timeout: 150_000 }, async () => {
  const harness = await createCodingHarness({ reviewedDigest: true, ownerRequests: true })
  try {
    const sessionId = await startSession(harness, 'claude', '#permit stop me')
    const request = await pendingOf(harness, sessionId)
    const stop = await act(harness, sessionId, { kind: 'interrupt' })
    assert.equal(stop.state, 'accepted')
    const cancelled = await requestWhere(harness, sessionId, (entry) => entry.id === request.id && entry.status !== 'pending',
      'the interrupted request')
    assert.deepEqual([cancelled.status, cancelled.reason], ['cancelled', 'turn_interrupted'])
    const permission = await recorded(harness, 'claude', 'permission')
    assert.equal((permission.response as { behavior: string }).behavior, 'deny')
    await harness.waitForStatus(sessionId, (body) => body.status === 'interrupted', OWNER)
    const late = await reply(harness, sessionId, { requestId: request.id, decision: 'accept' })
    assert.deepEqual([late.state, late.code], ['failed', 'request_not_pending'])

    const exiting = await startSession(harness, 'claude', '#permit and then crash')
    const waiting = await pendingOf(harness, exiting)
    const agentPid = await waitUntil(async () => {
      const starts = (await harness.agents()).filter((entry) => entry.event === 'start' && entry.agent === 'claude')
      return starts.length >= 2 ? starts.at(-1)!.pid as number : undefined
    }, 30_000, 'the second agent')
    process.kill(agentPid, 'SIGKILL')
    const expired = await requestWhere(harness, exiting, (entry) => entry.id === waiting.id && entry.status !== 'pending',
      'the expired request')
    assert.deepEqual([expired.status, expired.reason], ['expired', 'provider_exited'])
  } finally {
    await harness.cleanup()
  }
})

test('Codex approvals and questions reach the owner; a decline steers the turn and a cancel stops it', { timeout: 150_000 },
  async () => {
    const harness = await createCodingHarness({ reviewedDigest: true, ownerRequests: true })
    try {
      const sessionId = await startSession(harness, 'codex', '#permit #question build it')
      const approval = await pendingOf(harness, sessionId, 'command')
      assert.deepEqual([approval.title, approval.command, approval.cwd, approval.justification],
        ['Run git push --force', 'git push --force', '.', 'Publish the branch.'])
      assert.deepEqual(approval.decisions, ['accept', 'accept_for_session', 'decline', 'cancel'])
      await reply(harness, sessionId, { requestId: approval.id, decision: 'decline', feedback: 'Not yet.' })
      assert.deepEqual((await recorded(harness, 'codex', 'permission')).answer, { decision: 'decline' })
      assert.equal((await recorded(harness, 'codex', 'steer')).text, 'Not yet.', 'the feedback reaches the running turn')
      const question = await pendingOf(harness, sessionId, 'question')
      assert.deepEqual(question.questions?.map((entry) => [entry.id, entry.allowCustomAnswer, entry.options.length]),
        [['db', true, 2]])
      await reply(harness, sessionId, { requestId: question.id, answers: [{ questionId: 'db', values: ['Postgres'] }] })
      assert.deepEqual((await recorded(harness, 'codex', 'question')).answer, { answers: { db: { answers: ['Postgres'] } } })
      await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input', OWNER)

      const cancelling = await startSession(harness, 'codex', '#permit cancel me')
      const second = await pendingOf(harness, cancelling, 'command')
      await reply(harness, cancelling, { requestId: second.id, decision: 'cancel' })
      await harness.waitForStatus(cancelling, (body) => body.status === 'interrupted', OWNER)
    } finally {
      await harness.cleanup()
    }
  })

const SECRET = 'sk_test_51NessieNeverEchoesThisValue9876543210'

test('a secret reaches only its file: owner-only, one dotenv line, never echoed anywhere', { timeout: 150_000 }, async () => {
  const harness = await createCodingHarness({ reviewedDigest: true, ownerRequests: true })
  try {
    await writeFile(join(harness.root, '.env.local'), 'OTHER=1\nSTRIPE_KEY=old-value\n')
    const sessionId = await startSession(harness, 'claude', '#secret-tool connect stripe')
    const request = await pendingOf(harness, sessionId, 'secret')
    assert.deepEqual([request.secretName, request.destination, request.envName, request.decisions],
      ['Stripe test key', '.env.local', 'STRIPE_KEY', ['decline', 'cancel']])
    assert.equal((await reportedPending(harness, sessionId) as { kind: string }).kind, 'secret')
    const wrong = await reply(harness, sessionId, { requestId: request.id, decision: 'accept' })
    assert.equal(wrong.code, 'answer_shape_mismatch')
    const saved = await reply(harness, sessionId, { requestId: request.id, secret: SECRET })
    assert.deepEqual([saved.state, saved.code], ['accepted', 'secret_saved'])
    const file = join(harness.root, '.env.local')
    assert.equal(await readFile(file, 'utf8'), `OTHER=1\nSTRIPE_KEY=${SECRET}\n`)
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
    const used = await recorded(harness, 'claude', 'secret')
    assert.equal(used.permission, 'allow', 'the session\'s own secret tool needs no second prompt')
    const text = JSON.stringify(used.result)
    assert.match(text, /saved to \.env\.local/u)
    assert.equal(text.includes(SECRET), false, 'the tool result says where, never what')
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input', OWNER)
    const paths = codingSessionPaths(harness.stateDir, sessionId)
    const leaks: string[] = []
    const scan = async (dir: string): Promise<void> => {
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        const path = join(dir, name)
        if ((await stat(path)).isDirectory()) await scan(path)
        else if ((await readFile(path, 'utf8')).includes(SECRET)) leaks.push(path)
      }
    }
    await scan(harness.stateDir)
    await scan(harness.recordDir)
    assert.deepEqual(leaks, [], 'no state, log, request, receipt or event file holds the value')
    assert.equal(harness.outputs.some((output) => output.includes(SECRET)), false, 'no bridge answer carries it')
    const settled = JSON.parse(await readFile(paths.requests, 'utf8')) as { requests: ExecutorSessionRequest[] }
    assert.equal(settled.requests.find((entry) => entry.id === request.id)?.status, 'answered')
  } finally {
    await harness.cleanup()
  }
})

test('a Codex secret request the owner declines tells the agent so; an external session cannot be answered', { timeout: 150_000 },
  async () => {
    const harness = await createCodingHarness({ reviewedDigest: true, ownerRequests: true })
    try {
      const sessionId = await startSession(harness, 'codex', '#secret-tool connect stripe')
      const request = await pendingOf(harness, sessionId, 'secret')
      await reply(harness, sessionId, { requestId: request.id, decision: 'decline' })
      const used = await recorded(harness, 'codex', 'secret')
      assert.equal((used.result as { isError?: boolean }).isError, true)
      assert.match(JSON.stringify(used.result), /did not provide Stripe test key/u)
      assert.equal(used.timeout, 86_400, 'a secret may wait a day for its owner')
      // An answer for a session found open on the computer belongs to its own client.
      const external = await harness.call('session_user_action', { id: randomUUID(), ownerKey: EXISTING_CODING_SESSION_OWNER_KEY,
        sessionId: randomUUID(), kind: 'answer', answer: { requestId: 'req-x', decision: 'accept' },
        expiresAt: new Date(Date.now() + 60_000).toISOString() }, { daemon: true })
      assert.deepEqual((external.body.receipt as Receipt).code, 'request_not_answerable')
    } finally {
      await harness.cleanup()
    }
  })

test('until Nessie shows it reads requests, every prompt is turned down at once, as before', { timeout: 150_000 },
  async () => {
    const harness = await createCodingHarness({ reviewedDigest: true })
    try {
      const claude = await startSession(harness, 'claude', '#permit publish it')
      const permission = await recorded(harness, 'claude', 'permission')
      assert.deepEqual(permission.response, {
        behavior: 'deny', message: 'No person is at this terminal to approve this, so it was denied.',
      }, 'denied with the words a prompt got before it could reach the owner, and the turn goes on')
      await harness.waitForStatus(claude, (body) => body.status === 'waiting_for_input', OWNER)
      assert.equal((await conversation(harness, claude)).requests, undefined, 'nothing was put to the owner')
      assert.equal(await reportedPending(harness, claude), undefined)

      const codex = await startSession(harness, 'codex', '#permit build it')
      assert.deepEqual((await recorded(harness, 'codex', 'permission')).answer, { decision: 'decline' })
      await harness.waitForStatus(codex, (body) => body.status === 'waiting_for_input', OWNER)
      assert.equal((await harness.agents()).some((entry) => entry.event === 'steer'), false, 'no feedback is invented')

      const secret = await startSession(harness, 'claude', '#secret-tool connect stripe')
      const used = await recorded(harness, 'claude', 'secret')
      assert.match(JSON.stringify(used.result), /refused: owner_unreachable/u)
      await harness.waitForStatus(secret, (body) => body.status === 'waiting_for_input', OWNER)

      // Once the daemon says Nessie reads requests, the next prompt waits for the owner.
      await harness.ownerRequests(true)
      await delay(1_200)
      await harness.call('session_send', { sessionId: claude, message: '#permit again' }, { owner: OWNER })
      const waiting = await pendingOf(harness, claude, 'command')
      assert.equal(waiting.answerable, true)
    } finally {
      await harness.cleanup()
    }
  })
