import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ensureCodingStateDir, readJson, writeJsonAtomic } from '../src/coding-session/session-files.js'
import { existingAuthorityWriter } from '../src/existing-session/authority.js'
import { drainClaudeChannel, pendingClaudeEvents } from '../src/existing-session/channel-delivery.js'
import { channelInboxDir, type ChannelEvent } from '../src/existing-session/channel-files.js'

test('Claude channel claims before write, preserves order and checks disable between events', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-channel-'))
  const sessionId = randomUUID()
  const inbox = channelInboxDir(stateDir, sessionId)
  try {
    await ensureCodingStateDir(inbox)
    await existingAuthorityWriter(stateDir)(true)
    for (const [id, queuedAt] of [['bbb', 1], ['aaa', 2]] as const) {
      await writeJsonAtomic(join(inbox, `${id}.pending`), { commandId: id, queuedAt, sessionId,
        incarnation: 'pid:start', message: 'pokračuj', expiresAt: Date.now() + 60_000 })
    }
    const delivered: string[] = []
    await drainClaudeChannel({ stateDir, sessionId, incarnation: 'pid:start', notify: async (event) => {
      assert.ok((await readdir(inbox)).includes(`${event.commandId}.claimed`))
      delivered.push(event.commandId)
      await writeJsonAtomic(join(stateDir, 'existing-coding-sessions.json'), { enabled: false })
    } })
    assert.deepEqual(delivered, ['bbb'])
    assert.equal((await readJson<{ state: string }>(join(inbox, 'bbb.result')))?.state, 'written_to_transport')
    assert.equal((await readJson<{ state: string }>(join(inbox, 'aaa.result')))?.state, 'cancelled')
    assert.deepEqual((await readdir(inbox)).sort(), ['aaa.result', 'bbb.result'])
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('Claude channel cancels expired authority, stale incarnations and expired input', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-channel-'))
  const sessionId = randomUUID()
  const inbox = channelInboxDir(stateDir, sessionId)
  const event: ChannelEvent = { commandId: 'aaa', queuedAt: Date.now(), sessionId,
    incarnation: 'pid:start', message: 'next step', expiresAt: Date.now() + 60_000 }
  try {
    await ensureCodingStateDir(inbox)
    for (const failure of ['authority', 'incarnation', 'expired']) {
      await existingAuthorityWriter(stateDir)(true)
      if (failure === 'authority') {
        await writeJsonAtomic(join(stateDir, 'existing-session-authority.json'), { expiresAt: Date.now() - 1 })
      }
      await writeJsonAtomic(join(inbox, 'aaa.pending'), { ...event,
        ...(failure === 'incarnation' ? { incarnation: 'reused:pid' } : {}),
        ...(failure === 'expired' ? { expiresAt: Date.now() - 1 } : {}),
      })
      await drainClaudeChannel({ stateDir, sessionId, incarnation: 'pid:start',
        notify: async () => { assert.fail(`must reject ${failure}`) } })
      assert.equal((await readJson<{ state: string }>(join(inbox, 'aaa.result')))?.state, 'cancelled')
    }
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('Claude channel never replays an ambiguous transport write and removes malformed input', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-channel-'))
  const sessionId = randomUUID()
  const inbox = channelInboxDir(stateDir, sessionId)
  try {
    await ensureCodingStateDir(inbox)
    await existingAuthorityWriter(stateDir)(true)
    await writeFile(join(inbox, 'aaa.pending'), '{malformed')
    await writeJsonAtomic(join(inbox, 'bbb.pending'), { commandId: 'bbb', queuedAt: Date.now(), sessionId,
      incarnation: 'pid:start', message: 'next step', expiresAt: Date.now() + 60_000 })
    let writes = 0
    const input = { stateDir, sessionId, incarnation: 'pid:start', notify: async () => {
      writes += 1; throw new Error('transport lost')
    } }
    await assert.rejects(drainClaudeChannel(input), /transport lost/u)
    await drainClaudeChannel(input)
    assert.equal(writes, 1)
    assert.deepEqual(await readdir(inbox), ['bbb.claimed'])
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('expired Claude input releases capacity even when no channel is draining', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-channel-expiry-'))
  const sessionId = randomUUID()
  const inbox = channelInboxDir(stateDir, sessionId)
  try {
    await ensureCodingStateDir(inbox)
    for (let index = 0; index < 32; index += 1) {
      await writeJsonAtomic(join(inbox, `${index.toString(16)}.pending`), { commandId: String(index),
        sessionId, queuedAt: 1, incarnation: 'pid:start', message: 'expired', expiresAt: Date.now() - 1 })
    }
    assert.equal(await pendingClaudeEvents(inbox), 0)
    assert.equal((await readdir(inbox)).filter((name) => name.endsWith('.pending')).length, 0)
    assert.equal((await readJson<{ state: string }>(join(inbox, '0.result')))?.state, 'cancelled')
    await writeJsonAtomic(join(inbox, 'fff.pending'), { commandId: 'fresh', sessionId, queuedAt: Date.now(),
      incarnation: 'pid:start', message: 'fresh', expiresAt: Date.now() + 60_000 })
    assert.equal(await pendingClaudeEvents(inbox), 1)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('concurrent Claude drains claim each event once without stopping the losing channel', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-channel-race-'))
  const sessionId = randomUUID()
  const inbox = channelInboxDir(stateDir, sessionId)
  try {
    await ensureCodingStateDir(inbox)
    await existingAuthorityWriter(stateDir)(true)
    for (const commandId of ['aaa', 'bbb']) {
      await writeJsonAtomic(join(inbox, `${commandId}.pending`), { commandId, sessionId, queuedAt: Date.now(),
        incarnation: 'pid:start', message: 'once', expiresAt: Date.now() + 60_000 })
    }
    const writes: string[] = []
    const input = { stateDir, sessionId, incarnation: 'pid:start', notify: async (event: ChannelEvent) => {
      writes.push(event.commandId)
    } }
    await Promise.all([drainClaudeChannel(input), drainClaudeChannel(input)])
    assert.deepEqual(writes.sort(), ['aaa', 'bbb'])
    assert.equal((await readdir(inbox)).filter((name) => name.endsWith('.result')).length, 2)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})
