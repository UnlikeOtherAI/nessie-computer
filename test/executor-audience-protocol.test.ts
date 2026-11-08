import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXECUTOR_AUDIENCE_NAMED_MAXIMUM, ExecutorAvailabilityReasonSchema, ExecutorDaemonAudienceRequestSchema,
  ExecutorDaemonAudienceResponseSchema, ExecutorDaemonHeartbeatRequestSchema,
} from '@nessie/executor-protocol'

const executorId = '00000000-0000-4000-8000-000000000801'
const observedAt = '2026-11-08T12:00:00.000Z'
const signature = 'a'.repeat(86)

const answer = {
  agents: [{ id: 'agent-1', name: 'Sales assistant' }],
  everyoneInTeam: false,
  people: [{ name: 'Ondřej', isOwner: true }],
  peopleCount: 1,
  projects: [{ id: 'project-1', name: 'Launch' }],
  observedAt,
}

test('an audience request is the signed connection and nothing else', () => {
  const request = { connectionEpoch: '7', executorId, observedAt, signature }
  assert.ok(ExecutorDaemonAudienceRequestSchema.safeParse(request).success)
  assert.equal(ExecutorDaemonAudienceRequestSchema.safeParse({ ...request, connectionEpoch: 'x7' }).success, false)
  assert.equal(ExecutorDaemonAudienceRequestSchema.safeParse({ ...request, teamId: 't' }).success, false)
  const { signature: _signature, ...unsigned } = request
  assert.equal(ExecutorDaemonAudienceRequestSchema.safeParse(unsigned).success, false)
})

test('an audience answer names agents, people and projects within its bounds', () => {
  assert.deepEqual(ExecutorDaemonAudienceResponseSchema.parse(answer), answer)
  assert.deepEqual(ExecutorDaemonAudienceResponseSchema.parse({ ...answer, people: [{ name: '  Ana  ', isOwner: false }] })
    .people, [{ name: 'Ana', isOwner: false }])
  for (const wrong of [
    { ...answer, people: [{ name: '   ', isOwner: false }] },
    { ...answer, agents: [{ id: '', name: 'x' }] },
    { ...answer, peopleCount: -1 },
    { ...answer, everyoneInTeam: 'yes' },
    { ...answer, projects: [{ id: 'p', name: 'x', extra: true }] },
    { ...answer, email: 'owner@example.test' },
    { ...answer, people: Array.from({ length: EXECUTOR_AUDIENCE_NAMED_MAXIMUM + 1 }, (_, index) => (
      { name: `Person ${index}`, isOwner: false })) },
  ]) assert.equal(ExecutorDaemonAudienceResponseSchema.safeParse(wrong).success, false, JSON.stringify(wrong).slice(0, 80))
})

test('a heartbeat says ownerPaused only while paused, and Nessie has a reason for it', () => {
  const heartbeat = { connectionEpoch: '7', executorId, observedAt, signature }
  assert.ok(ExecutorDaemonHeartbeatRequestSchema.safeParse(heartbeat).success)
  assert.ok(ExecutorDaemonHeartbeatRequestSchema.safeParse({ ...heartbeat, ownerPaused: true }).success)
  assert.equal(ExecutorDaemonHeartbeatRequestSchema.safeParse({ ...heartbeat, ownerPaused: false }).success, false,
    'not paused is the absent field, so an unpaused payload signs as it always did')
  assert.equal(ExecutorAvailabilityReasonSchema.parse('owner_paused'), 'owner_paused')
})
