import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ExecutorSessionRequest } from '@nessie/executor-protocol'

import { createAnswerKey, sealAnswer } from '../src/coding-session/answer-seal.js'
import { createPathRewriter } from '../src/coding-session/path-rewrite.js'
import { createProjector } from '../src/coding-session/projection.js'
import { unsealHostAnswer } from '../src/coding-session/secret-redactions.js'
import { answerSessionRequest } from '../src/coding-session/session-answer.js'
import { codingSessionPaths, ensurePrivateDir, type CodingSessionPaths } from '../src/coding-session/session-files.js'
import { writeSessionRequests } from '../src/coding-session/session-request-file.js'
import { listRequests } from '../src/coding-session/session-requests.js'

/**
 * The bridge's half of an answer: claimed as an intent, reported accepted
 * only once it reached the host's inbox, and settled by whoever finds a claim
 * whose bridge stopped mid-delivery. What the owner typed in secret reaches
 * the inbox only sealed to the host's key.
 */

const now = (): string => new Date().toISOString()
const command: ExecutorSessionRequest = {
  id: 'req-command', kind: 'command', status: 'pending', answerable: true, openedAt: now(), title: 'Run ls',
  command: 'ls', decisions: ['accept', 'decline'],
}
const PASSWORD = 'correct horse battery staple'
const question: ExecutorSessionRequest = {
  id: 'req-question', kind: 'question', status: 'pending', answerable: true, openedAt: now(), title: 'Sign in',
  decisions: ['decline', 'cancel'], questions: [
    { id: 'user', question: 'User?', options: [], multiSelect: false, allowCustomAnswer: true, secret: false },
    { id: 'pass', question: 'Password?', options: [], multiSelect: false, allowCustomAnswer: true, secret: true },
  ],
}
const SECRET = 'sk_test_51NessieNeverWritesThisDown0123'
const secret: ExecutorSessionRequest = {
  id: 'req-secret', kind: 'secret', status: 'pending', answerable: true, openedAt: now(), title: 'Provide a key',
  secretName: 'key', destination: '.env', envName: 'KEY', decisions: ['decline', 'cancel'],
}

const setup = async (answerKey?: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-answer-'))
  const paths = codingSessionPaths(join(dir, 'state'), randomUUID())
  const folder = join(dir, 'work')
  await mkdir(folder)
  await ensurePrivateDir(paths.inbox)
  await writeSessionRequests(paths, [command, question, secret], answerKey)
  const answer = (answer: Record<string, unknown>, commandId = randomUUID()) => answerSessionRequest({
    paths, answer, commandId, hostLive: true, folder: async () => folder, ensureHost: async () => undefined,
  })
  return { dir, paths, folder, answer }
}

/** A pid that has certainly exited. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid

const strandedClaim = async (paths: CodingSessionPaths, requestId: string, commandId: string, pid = deadPid()) => {
  await ensurePrivateDir(paths.answers)
  await writeFile(join(paths.answers, `${requestId}.json`), JSON.stringify({
    commandId, at: now(), outcome: { state: 'accepted', code: 'answer_delivered' }, stage: 'delivering',
    life: randomUUID(), pid,
  }))
}

const filesUnder = async (dir: string): Promise<string> => {
  const names = await readdir(dir, { recursive: true, withFileTypes: true })
  const texts = await Promise.all(names.filter((entry) => entry.isFile())
    .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')))
  return texts.join('\n')
}

test('accepted is reported once the answer is in the inbox, and a replay reads it', async () => {
  const { dir, paths, answer } = await setup()
  try {
    const id = randomUUID()
    assert.deepEqual(await answer({ requestId: command.id, decision: 'accept' }, id), { state: 'accepted', code: 'answer_delivered' })
    assert.deepEqual((await listRequests(paths)).map((request) => request.id), [`answer-${id}`])
    const claim = JSON.parse(await readFile(join(paths.answers, `${command.id}.json`), 'utf8')) as { stage: string }
    assert.equal(claim.stage, 'delivered')
    assert.deepEqual(await answer({ requestId: command.id, decision: 'accept' }, id), { state: 'accepted', code: 'answer_delivered' })
    assert.deepEqual(await answer({ requestId: command.id, decision: 'decline' }), { state: 'failed', code: 'request_not_pending' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a claim whose bridge stopped before the inbox is released: the next answer, or the replay, delivers', async () => {
  const { dir, paths, answer } = await setup()
  try {
    const lost = randomUUID()
    await strandedClaim(paths, command.id, lost)
    const fresh = randomUUID()
    assert.deepEqual(await answer({ requestId: command.id, decision: 'decline' }, fresh),
      { state: 'accepted', code: 'answer_delivered' }, 'the owner\'s next answer is not refused for an answer that never arrived')
    assert.deepEqual((await listRequests(paths)).map((request) => request.id), [`answer-${fresh}`])

    await rm(join(paths.answers, `${command.id}.json`))
    await rm(join(paths.inbox, `answer-${fresh}.json`))
    await strandedClaim(paths, command.id, lost)
    assert.deepEqual(await answer({ requestId: command.id, decision: 'accept' }, lost),
      { state: 'accepted', code: 'answer_delivered' }, 'a replay of the lost action delivers it')
    assert.deepEqual((await listRequests(paths)).map((request) => request.id), [`answer-${lost}`])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a claim whose answer did reach the inbox is completed, not delivered twice', async () => {
  const { dir, paths, answer } = await setup()
  try {
    const lost = randomUUID()
    await strandedClaim(paths, command.id, lost)
    await writeFile(join(paths.inbox, `answer-${lost}.json`), JSON.stringify({ id: `answer-${lost}`, kind: 'answer',
      answer: { requestId: command.id, decision: 'accept' }, at: now() }))
    assert.deepEqual(await answer({ requestId: command.id, decision: 'decline' }), { state: 'failed', code: 'request_not_pending' })
    assert.deepEqual(await answer({ requestId: command.id, decision: 'accept' }, lost), { state: 'accepted', code: 'answer_delivered' })
    assert.equal((await listRequests(paths)).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a delivery still in flight in a live bridge is left alone', async () => {
  const { dir, paths, answer } = await setup()
  try {
    const flying = randomUUID()
    await strandedClaim(paths, command.id, flying, process.pid)
    assert.deepEqual(await answer({ requestId: command.id, decision: 'decline' }), { state: 'failed', code: 'request_not_pending' })
    assert.deepEqual(await answer({ requestId: command.id, decision: 'accept' }, flying),
      { state: 'outcome_unknown', code: 'answer_in_progress' })
    assert.equal((await listRequests(paths)).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a secret question\'s value and a secret\'s value reach the inbox only sealed to the host', async () => {
  const key = createAnswerKey()
  const { dir, paths, folder, answer } = await setup(key.publicKey)
  try {
    assert.equal((await answer({ requestId: question.id, answers: [{ questionId: 'user', values: ['ondre'] },
      { questionId: 'pass', values: [PASSWORD] }] })).state, 'accepted')
    assert.equal((await answer({ requestId: secret.id, secret: SECRET })).code, 'secret_saved')
    assert.equal(await readFile(join(folder, '.env'), 'utf8'), `KEY=${SECRET}\n`)
    const state = await filesUnder(join(dir, 'state'))
    assert.equal(state.includes(PASSWORD) || state.includes(SECRET), false, 'no inbox, claim or record holds either value')

    const projector = createProjector(createPathRewriter([{ name: 'work', paths: [folder] }], process.platform))
    const delivered = (await listRequests(paths)).map((request) => unsealHostAnswer(request.answer!, key, projector))
    assert.deepEqual(delivered[0]?.answers, [{ questionId: 'user', values: ['ondre'] }, { questionId: 'pass', values: [PASSWORD] }])
    assert.equal(delivered[1]?.secretSaved, true)
    assert.equal(projector.text(`typed ${PASSWORD}; key ${SECRET}`, 1_000), 'typed <secret>; key <secret>',
      'both are redacted before the provider hears anything')
    assert.equal(unsealHostAnswer((await listRequests(paths))[0]!.answer!, createAnswerKey(), projector), undefined,
      'another host\'s key opens nothing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a host too old to have a key is never given a secret question\'s value', async () => {
  const { dir, paths, answer } = await setup()
  try {
    assert.deepEqual(await answer({ requestId: question.id, answers: [{ questionId: 'user', values: ['ondre'] },
      { questionId: 'pass', values: [PASSWORD] }] }), { state: 'failed', code: 'request_not_answerable' })
    assert.equal((await listRequests(paths)).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a sealed answer opens only for its own request', () => {
  const key = createAnswerKey()
  const sealed = sealAnswer(key.publicKey, 'req-a', { secret: 'value' })
  assert.deepEqual(key.open(sealed, 'req-a'), { secret: 'value' })
  assert.equal(key.open(sealed, 'req-b'), undefined)
  assert.equal(key.open({ ...sealed, data: Buffer.from('x').toString('base64') }, 'req-a'), undefined)
})
