import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  EXISTING_CODING_SESSION_OWNER_KEY, ExecutorLocalMcpReportSchema, type ExecutorLocalMcpReport,
} from '@nessie/executor-protocol'

import { ownerRequestsLeaseIsLive, ownerRequestsLeaseWriter } from '../src/coding-session/owner-requests-lease.js'
import { createOwnerRequestsGate, reportForServer } from '../src/owner-requests-gate.js'

const now = new Date().toISOString()
const report: ExecutorLocalMcpReport = ExecutorLocalMcpReportSchema.parse([{
  server: 'coding-sessions', available: true, observedAt: now, toolCount: 3,
  codingSessions: [{
    sessionId: randomUUID(), ownerKey: EXISTING_CODING_SESSION_OWNER_KEY, origin: 'external', title: 'Codex thread',
    status: 'working', agent: 'codex', root: 'work', updatedAt: now,
    pending: { kind: 'approval', count: 1, answerable: false, since: now },
  }],
}])

test('the gate opens on a ready for the current connection epoch only', () => {
  let epoch: string | undefined = '4'
  const gate = createOwnerRequestsGate(() => epoch)
  assert.equal(gate.understood(), false, 'no doorbell has said ready: an older Nessie, as far as anyone knows')
  gate.ready('3')
  assert.equal(gate.understood(), false, 'a ready under an earlier epoch says nothing about this connection')
  gate.ready('4')
  assert.equal(gate.understood(), true)
  epoch = '5'
  assert.equal(gate.understood(), false, 'a reconnect may meet a different Nessie')
  epoch = undefined
  assert.equal(gate.understood(), false)
})

test('the heartbeat report leaves pending out until Nessie has shown it reads it', () => {
  const sent = reportForServer(report, false)
  assert.equal(sent?.[0]?.codingSessions?.[0]?.pending, undefined, 'a waiting Codex thread no longer takes the computer offline')
  assert.equal(sent?.[0]?.codingSessions?.[0]?.title, 'Codex thread', 'everything else is reported as before')
  assert.equal(report[0]?.codingSessions?.[0]?.pending?.kind, 'approval', 'the report itself is not changed')
  assert.deepEqual(reportForServer(report, true), report)
  assert.equal(reportForServer(undefined, false), undefined)
})

test('the owner-requests lease lives a minute and ends at once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-owner-requests-'))
  try {
    await mkdir(dir, { recursive: true })
    assert.equal(await ownerRequestsLeaseIsLive(dir), false, 'no lease: prompts are turned down')
    const write = ownerRequestsLeaseWriter(dir)
    await write(true)
    assert.equal(await ownerRequestsLeaseIsLive(dir), true)
    assert.equal(await ownerRequestsLeaseIsLive(dir, Date.now() + 61_000), false, 'nobody renewed it: it lapsed')
    await write(false)
    assert.equal(await ownerRequestsLeaseIsLive(dir), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
