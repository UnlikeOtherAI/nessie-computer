import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ExecutorSessionConversationSchema } from '@nessie/executor-protocol'
import { createCodingHarness, waitUntil } from './coding-session-harness.js'
import { codingSessionPaths } from '../src/coding-session/session-files.js'

test('daemon conversation input reaches one managed host once and observations leave delivery untouched',
  { timeout: 120_000 }, async () => {
    const harness = await createCodingHarness({ reviewedDigest: true })
    const owner = 'sha256:' + 'a'.repeat(64)
    try {
      const started = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: '#hold=chat initial task' }, { owner })
      assert.equal(started.ok, true, JSON.stringify(started.body))
      const sessionId = String(started.body.sessionId)
      await harness.waitForStatus(sessionId, (row) => row.status === 'working', owner)
      const paths = codingSessionPaths(harness.stateDir, sessionId)
      const before = await readFile(paths.delivered, 'utf8').catch(() => null)
      const observed = await harness.call('session_conversation', { sessionId, ownerKey: owner }, { daemon: true })
      const conversation = ExecutorSessionConversationSchema.parse(observed.body.conversation)
      assert(conversation.messages.length > 0)
      assert.equal(await readFile(paths.delivered, 'utf8').catch(() => null), before)
      const action = { id: randomUUID(), ownerKey: OWNER_A, sessionId, kind: 'managed', message: 'also check the UI',
        expiresAt: new Date(Date.now() + 60_000).toISOString() }
      const sent = await harness.call('session_user_action', action, { daemon: true })
      assert.equal((sent.body.receipt as { state: string }).state, 'accepted', JSON.stringify(sent.body))
      const replay = await harness.call('session_user_action', action, { daemon: true })
      assert.equal((replay.body.receipt as { state: string }).state, 'accepted')
      await waitUntil(async () => (await harness.agents()).some((row) => row.text === action.message) ? true : undefined,
        30_000, 'the existing managed agent to receive the message')
      assert.equal((await harness.agents()).filter((row) => row.text === action.message).length, 1)
      const denied = await harness.call('session_user_action', { ...action, id: randomUUID() })
      assert.equal(denied.ok, false, 'an agent cannot impersonate the daemon human-input lane')
      const stop = await harness.call('session_user_action', { ...action, id: randomUUID(), kind: 'interrupt',
        message: undefined }, { daemon: true })
      assert.equal((stop.body.receipt as { state: string }).state, 'accepted')
      await harness.waitForStatus(sessionId, (row) => row.status === 'interrupted', owner)
    } finally { await harness.cleanup() }
  })
