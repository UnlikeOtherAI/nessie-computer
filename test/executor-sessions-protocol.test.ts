import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ExecutorCommandEnvelopeSchema,
  ExecutorDaemonCommandPollRequestSchema,
  ExecutorDaemonCommandPollResponseSchema,
  ExecutorDaemonConcurrentCommandPollResponseSchema,
  ExecutorDaemonLegacyCommandPollResponseSchema,
  executorCommandCapacityKind,
} from '@nessie/executor-protocol'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const base = { connectionEpoch: '3', executorId: id(1), observedAt: '2026-11-08T12:00:00.000Z', signature: 'c2ln' }
const target = {
  argumentDigest: `sha256:${'a'.repeat(64)}`, bindingFence: '1', bindingId: id(2), capabilityRevision: 1,
  commandId: id(3), expiresAt: '2099-01-01T00:00:00.000Z', idempotencyKey: 'k',
}
const envelope = { ...target, operationKey: 'file.read', payload: { args: { path: 'a' }, runId: id(4) } }
const capacity = { file: 16, program: 4, coding: 2, browser: 2, mcp: 8 }

test('the polls every daemon sent keep parsing', () => {
  assert.ok(ExecutorDaemonCommandPollRequestSchema.safeParse(base).success)
  assert.ok(ExecutorDaemonCommandPollRequestSchema.safeParse({ ...base, activeCommand: target }).success)
  assert.ok(ExecutorDaemonCommandPollResponseSchema.safeParse({ command: null }).success)
  assert.ok(ExecutorDaemonCommandPollResponseSchema.safeParse({ command: envelope, cancellation: null }).success)
  assert.ok(ExecutorDaemonLegacyCommandPollResponseSchema.safeParse({ command: envelope }).success)
})

test('a concurrent poll sends capacity and activeCommands, and never the single activeCommand', () => {
  const concurrent = { ...base, concurrency: 1, capacity, activeCommands: [target] }
  assert.ok(ExecutorDaemonCommandPollRequestSchema.safeParse(concurrent).success)
  assert.ok(ExecutorDaemonCommandPollRequestSchema.safeParse({
    ...concurrent, waiting: [{ commandId: id(3), for: 'owner' }], stoppedSessions: [id(5)],
  }).success)
  assert.equal(ExecutorDaemonCommandPollRequestSchema.safeParse({ ...base, concurrency: 1, capacity }).success, false)
  assert.equal(ExecutorDaemonCommandPollRequestSchema.safeParse({ ...concurrent, activeCommand: target }).success, false)
  assert.equal(ExecutorDaemonCommandPollRequestSchema.safeParse({ ...base, capacity }).success, false)
  assert.equal(ExecutorDaemonCommandPollRequestSchema.safeParse({ ...concurrent, waiting: [] }).success, false)
  assert.equal(ExecutorDaemonCommandPollRequestSchema.safeParse({ ...concurrent, concurrency: 2 }).success, false)
})

test('the concurrent answer carries commands with their session, cancellations and session closes', () => {
  const answer = {
    commands: [{ ...envelope, sessionId: id(6), agentName: 'Sales agent' }],
    cancellations: [{ ...target, requestedAt: '2026-11-08T12:00:01.000Z' }],
    sessionClose: [{ sessionId: id(6), reason: 'run_ended' }, { sessionId: id(7), reason: 'some_future_reason' }],
  }
  assert.ok(ExecutorDaemonConcurrentCommandPollResponseSchema.safeParse(answer).success)
  assert.ok(ExecutorDaemonCommandPollResponseSchema.safeParse(answer).success)
  assert.equal(ExecutorDaemonConcurrentCommandPollResponseSchema.safeParse({ commands: [] }).success, false)
  assert.equal(ExecutorDaemonCommandPollResponseSchema.safeParse({ ...answer, command: null }).success, false)
})

test('an envelope without a session is the envelope older daemons read', () => {
  assert.ok(ExecutorCommandEnvelopeSchema.safeParse(envelope).success)
  assert.ok(ExecutorCommandEnvelopeSchema.safeParse({ ...envelope, sessionId: id(6) }).success)
  assert.equal(ExecutorCommandEnvelopeSchema.safeParse({ ...envelope, agentName: '' }).success, false)
})

test('capacity kinds are shared, and a stop takes no slot', () => {
  assert.equal(executorCommandCapacityKind('command.run'), 'program')
  assert.equal(executorCommandCapacityKind('file.write'), 'file')
  assert.equal(executorCommandCapacityKind('workspace.promote'), 'file')
  assert.equal(executorCommandCapacityKind('browser.connected.act'), 'browser')
  assert.equal(executorCommandCapacityKind('coding.observe'), 'coding')
  assert.equal(executorCommandCapacityKind('mcp.call'), 'mcp')
  assert.equal(executorCommandCapacityKind('sandbox.stop'), null)
})
