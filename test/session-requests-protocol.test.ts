import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  ExecutorDaemonSocketServerFrameSchema, ExecutorSessionActionBodySchema, ExecutorSessionAnswerSchema,
  ExecutorSessionRequestSchema, summarizePendingRequests, type ExecutorSessionRequest,
} from '@nessie/executor-protocol'

const request = (overrides: Partial<ExecutorSessionRequest>): ExecutorSessionRequest =>
  ExecutorSessionRequestSchema.parse({
  answerable: true, id: 'r1', kind: 'command', openedAt: '2026-11-06T22:00:00.000Z', status: 'pending',
  title: 'Run pnpm test', command: 'pnpm test', cwd: '.', decisions: ['accept', 'accept_for_session', 'decline'],
  ...overrides,
})

test('an answer carries exactly one shape, and feedback only with a decline', () => {
  assert.ok(ExecutorSessionAnswerSchema.safeParse({ requestId: 'r1', decision: 'accept' }).success)
  assert.ok(ExecutorSessionAnswerSchema.safeParse({ requestId: 'r1', decision: 'decline', feedback: 'Use vitest' }).success)
  assert.ok(ExecutorSessionAnswerSchema.safeParse({ requestId: 'r1', secret: 'sk-live' }).success)
  assert.ok(ExecutorSessionAnswerSchema.safeParse({ requestId: 'q', answers: [{ questionId: 'a', values: ['Postgres'] }] }).success)
  assert.equal(ExecutorSessionAnswerSchema.safeParse({ requestId: 'r1' }).success, false)
  assert.equal(ExecutorSessionAnswerSchema.safeParse({ requestId: 'r1', decision: 'accept', secret: 'x' }).success, false)
  assert.equal(ExecutorSessionAnswerSchema.safeParse({ requestId: 'r1', decision: 'accept', feedback: 'x' }).success, false)
})

test('only an answer action carries an answer, and it carries no message', () => {
  const answer = { requestId: 'r1', decision: 'accept' as const }
  assert.ok(ExecutorSessionActionBodySchema.safeParse({ id: randomUUID(), kind: 'answer', answer }).success)
  assert.equal(ExecutorSessionActionBodySchema.safeParse({ id: randomUUID(), kind: 'answer' }).success, false)
  assert.equal(ExecutorSessionActionBodySchema.safeParse({ id: randomUUID(), kind: 'answer', answer, message: 'hi' }).success, false)
  assert.equal(ExecutorSessionActionBodySchema.safeParse({ id: randomUUID(), kind: 'managed', message: 'hi', answer }).success, false)
  assert.ok(ExecutorSessionActionBodySchema.safeParse({ id: randomUUID(), kind: 'interrupt' }).success)
})

test('a list row learns the kind of wait without any of its content', () => {
  assert.equal(summarizePendingRequests([request({ status: 'answered' })]), undefined)
  const summary = summarizePendingRequests([
    request({ id: 'late', openedAt: '2026-11-06T22:05:00.000Z' }),
    request({ id: 'q', kind: 'question', openedAt: '2026-11-06T22:01:00.000Z', questions: [{
      id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }], multiSelect: false,
      allowCustomAnswer: true, secret: false,
    }] }),
  ])
  assert.deepEqual(summary, { answerable: true, count: 2, kind: 'question', since: '2026-11-06T22:01:00.000Z' })
  assert.equal(summarizePendingRequests([request({ answerable: false })])?.answerable, false)
  assert.equal(summarizePendingRequests([request({}), request({ id: 's', kind: 'secret', secretName: 'Stripe key',
    destination: '.env.local', envName: 'STRIPE_KEY' })])?.kind, 'secret')
})

test('the doorbell names a topic and nothing else', () => {
  assert.ok(ExecutorDaemonSocketServerFrameSchema.safeParse({ type: 'wake', topics: ['session_views'] }).success)
  assert.ok(ExecutorDaemonSocketServerFrameSchema.safeParse({ type: 'ready', pollSeconds: 15 }).success)
  assert.equal(ExecutorDaemonSocketServerFrameSchema.safeParse({ type: 'wake', topics: [] }).success, false)
  assert.equal(ExecutorDaemonSocketServerFrameSchema.safeParse({ type: 'wake', topics: ['commands'], action: {} }).success, false)
})
