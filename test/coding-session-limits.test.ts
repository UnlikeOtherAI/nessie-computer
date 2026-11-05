import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { alive, createCodingHarness, waitUntil } from './coding-session-harness.js'

/**
 * The config's hard limits, over the real bridge: a runaway turn is
 * interrupted at maxTurnMinutes, and an idle agent process is ended at
 * idleMinutes while its session stays resumable.
 */

test('a turn that runs past maxTurnMinutes is interrupted and says why', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({ codingSessions: { maxTurnMinutes: 0.05 } })
  try {
    const started = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: '#sleep=120000 runaway' })
    const sessionId = started.body.sessionId as string
    const stopped = await harness.waitForStatus(sessionId, (body) => body.status === 'interrupted', undefined, 60_000)
    assert.equal((stopped.lastResult as { subtype: string }).subtype, 'error_during_execution')
    assert.equal(stopped.reason, 'max_turn_minutes')
    const events = await harness.call('session_status', { sessionId, detail: 'events', cursor: '0.0.0' })
    assert.ok((events.body.events as { subtype?: string; reason?: string }[])
      .some((event) => event.subtype === 'limit' && event.reason === 'max_turn_minutes'))
  } finally {
    await harness.cleanup()
  }
})

test('a turn that ignores the interrupt loses its agent a grace later, and the session resumes', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({ codingSessions: { maxTurnMinutes: 0.05 } })
  try {
    const started = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: '#stubborn #sleep=120000 runaway' })
    const sessionId = started.body.sessionId as string
    const stopped = await harness.waitForStatus(sessionId, (body) => body.status === 'interrupted', undefined, 60_000)
    assert.equal(stopped.reason, 'max_turn_minutes')
    const first = (await harness.agents()).find((entry) => entry.event === 'start')!
    await waitUntil(async () => (alive(first.pid as number) ? undefined : true), 15_000, 'the stubborn agent to end')
    await harness.call('session_send', { sessionId, message: 'something short' })
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    assert.match((done.lastResult as { text: string }).text, /something short/)
    const starts = (await harness.agents()).filter((entry) => entry.event === 'start')
    assert.deepEqual(starts.map((entry) => entry.resume), [false, true])
  } finally {
    await harness.cleanup()
  }
})

test('with a budget, each new turn starts in a fresh process that resumes the session', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({ codingSessions: { maxBudgetUsd: 5 } })
  try {
    const started = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'first' })
    const sessionId = started.body.sessionId as string
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    await harness.call('session_send', { sessionId, message: 'second' })
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input' && body.turn === 2)
    assert.match((done.lastResult as { text: string }).text, /second/)
    const starts = (await harness.agents()).filter((entry) => entry.event === 'start')
    // The CLI counts --max-budget-usd against a per-process running total.
    assert.deepEqual(starts.map((entry) => entry.resume), [false, true])
    assert.equal(starts[1]!.sessionId, starts[0]!.sessionId)
    assert.ok((starts[1]!.argv as string[]).includes('--max-budget-usd'))
  } finally {
    await harness.cleanup()
  }
})

test('an idle agent is ended, its host leaves, and the next message resumes the same session', { timeout: 120_000 }, async () => {
  const harness = await createCodingHarness({ codingSessions: { idleMinutes: 0.05 } })
  try {
    const started = await harness.call('session_start', { agent: 'claude', root: 'work', prompt: 'short task' })
    const sessionId = started.body.sessionId as string
    await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input')
    const first = (await harness.agents()).find((entry) => entry.event === 'start')!
    const lock = join(harness.stateDir, 'sessions', sessionId, 'host.lock')
    await waitUntil(async () => (!alive(first.pid as number) && !existsSync(lock) ? true : undefined), 30_000, 'the idle agent to end')
    assert.equal((await harness.call('session_status', { sessionId })).body.status, 'waiting_for_input', 'idle is not lost')
    await harness.call('session_send', { sessionId, message: 'one more thing' })
    const done = await harness.waitForStatus(sessionId, (body) => body.status === 'waiting_for_input' && body.turn === 2)
    assert.match((done.lastResult as { text: string }).text, /one more thing/)
    const starts = (await harness.agents()).filter((entry) => entry.event === 'start')
    assert.deepEqual(starts.map((entry) => entry.resume), [false, true])
    assert.equal(starts[1]!.sessionId, first.sessionId)
  } finally {
    await harness.cleanup()
  }
})
