import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXECUTOR_DAEMON_TEAMS_MAXIMUM, ExecutorDaemonTeamsRequestSchema, ExecutorDaemonTeamsResponseSchema,
} from '@nessie/executor-protocol'

const executorId = (index: number) => `00000000-0000-4000-8000-${String(900 + index).padStart(12, '0')}`
const observedAt = '2026-11-08T12:00:00.000Z'
const signature = 'a'.repeat(86)
const entry = (index: number) => ({ executorId: executorId(index), observedAt, signature })

test('a teams request is a batch of signed executors, each once', () => {
  assert.ok(ExecutorDaemonTeamsRequestSchema.safeParse({ entries: [entry(1), entry(2)] }).success)
  for (const wrong of [
    { entries: [] },
    { entries: [entry(1), entry(1)] },
    { entries: [{ executorId: executorId(1), observedAt }] },
    { entries: [{ ...entry(1), connectionEpoch: '7' }] },
    { entries: [entry(1)], personId: 'p' },
    { entries: Array.from({ length: EXECUTOR_DAEMON_TEAMS_MAXIMUM + 1 }, (_, index) => entry(index)) },
  ]) {
    assert.equal(ExecutorDaemonTeamsRequestSchema.safeParse(wrong).success, false, JSON.stringify(wrong).slice(0, 80))
  }
})

test('a teams answer gives display names per executor and nothing else', () => {
  const sales = { executorId: executorId(1), organizationName: 'Acme', teamName: 'Sales' }
  const wholeOrganisation = { executorId: executorId(2), organizationName: 'Acme', teamName: null }
  assert.deepEqual(ExecutorDaemonTeamsResponseSchema.parse({ teams: [sales, wholeOrganisation] }).teams,
    [sales, wholeOrganisation])
  assert.deepEqual(ExecutorDaemonTeamsResponseSchema.parse({ teams: [{ ...sales, teamName: '  Sales ' }] }).teams,
    [sales])
  assert.ok(ExecutorDaemonTeamsResponseSchema.safeParse({ teams: [] }).success, 'every entry may be left out')
  for (const wrong of [
    { executorId: executorId(1), organizationName: 'Acme' },
    { executorId: executorId(1), organizationName: '  ', teamName: 'Sales' },
    { ...sales, teamId: 'team-1' },
    { ...sales, members: [] },
    { ...sales, executorId: 'not-a-uuid' },
  ]) {
    assert.equal(ExecutorDaemonTeamsResponseSchema.safeParse({ teams: [wrong] }).success, false, JSON.stringify(wrong))
  }
})
