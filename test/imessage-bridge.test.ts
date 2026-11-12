import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ExecutorIMessageSendTextSchema, type ExecutorIMessageIncoming, type ExecutorIMessageOutboxResult,
} from '@nessie/executor-protocol'

import { ChatDatabaseError } from '../src/imessage/chat-database.js'
import { IMessageBridge } from '../src/imessage/imessage-bridge.js'
import type { IMessageCursor } from '../src/imessage/imessage-cursor.js'
import { orderedAddresses } from '../src/imessage/imessage-addresses.js'
import { withHostIMessageOperation } from '../src/imessage/imessage-operation.js'
import { classifyScriptFailure, createMessagesApp, type ScriptOutcome } from '../src/imessage/messages-script.js'
import { createChatDatabase, insertMessage, seedChats, type Database } from './imessage-fixture.js'

const SINCE = '2026-11-11T08:30:00.000Z'
const NOW = new Date('2026-11-11T10:00:00.000Z')
const OWN = '+447700900500'

const setUp = async (t: test.TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-imessage-bridge-'))
  const databasePath = join(directory, 'chat.db')
  const fixture = createChatDatabase(databasePath)
  let cursor: IMessageCursor | null = null
  const cursorStore = { load: async () => cursor, save: async (next: IMessageCursor) => { cursor = next } }
  seedChats(fixture)
  insertMessage(fixture, { guid: 'before', text: 'Older', handle: 1, chat: 1, at: '2026-11-11T08:00:00Z' })
  insertMessage(fixture, { guid: 'g-1', text: 'Hi', handle: 1, chat: 1, at: '2026-11-11T09:00:00Z' })
  insertMessage(fixture, { guid: 'g-2', text: 'Climbing tonight?', handle: 2, chat: 2, at: '2026-11-11T09:10:00Z' })
  const delivered: ExecutorIMessageIncoming[][] = []
  const probes: ScriptOutcome[] = [{ ok: true, output: '1' }]
  const sends: Array<[string, string]> = []
  let sendOutcome: ScriptOutcome = { ok: true, output: '' }
  // Whether Messages records the message, whatever the script answered; by default only when it answered.
  let recorded: boolean | null = null
  let stored: (messages: ExecutorIMessageIncoming[]) => string[] = (messages) => messages.map((message) => message.guid)
  let paused = false
  let reports = 0
  let reportSent: (results: ExecutorIMessageOutboxResult[]) => Promise<string[]> =
    async (results) => results.map((result) => result.id)
  const bridge = new IMessageBridge({
    stateDir: directory, supported: true, databasePath, paused: () => paused,
    deliver: async (messages) => {
      delivered.push(messages)
      return { stored: stored(messages), switch: { enabled: true, since: SINCE, address: OWN, mode: 'assistant' as const } }
    },
    onReportChanged: () => { reports += 1 },
    reportSent: (results) => reportSent(results),
    messages: {
      probe: async () => probes.shift() ?? { ok: true, output: '1' },
      send: async (handle, text) => {
        sends.push([handle, text])
        if (recorded ?? sendOutcome.ok) {
          insertMessage(fixture, { guid: 'sent-1', text, handle: 1, chat: 1, fromMe: true, at: NOW.toISOString(), own: OWN })
        }
        return sendOutcome
      },
    },
    now: () => NOW,
    sleep: async () => undefined,
    watchFolder: () => () => undefined,
    cursor: cursorStore,
    readAddresses: async () => [{ address: OWN, kind: 'phone' }, { address: 'me@example.com', kind: 'email' }],
  })
  // Windows will not remove a database that is still open.
  t.after(async () => {
    bridge.stop()
    await bridge.idle()
    fixture.close()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    bridge, directory, fixture, delivered, probes, sends, cursor: () => cursor,
    setSendOutcome: (outcome: ScriptOutcome) => { sendOutcome = outcome },
    setRecorded: (value: boolean | null) => { recorded = value },
    setStored: (next: typeof stored) => { stored = next },
    setPaused: (value: boolean) => { paused = value },
    setReportSent: (next: typeof reportSent) => { reportSent = next },
    reports: () => reports,
  }
}

/** The owner wrote to Alice from the chosen address before: evidence of where Messages sends to her from. */
const proveAddress = (fixture: Database): void => insertMessage(fixture, { guid: 'earlier-mine', text: 'See you',
  handle: 1, chat: 1, fromMe: true, at: '2026-11-11T08:05:00Z', own: OWN })

test('nothing is reported to a Nessie that never mentioned iMessage, and off reads as off', async (t) => {
  const context = await setUp(t)
  const { bridge } = context
  assert.equal(bridge.report(), undefined)
  bridge.applySwitch({ enabled: false, since: null, address: null, mode: 'assistant' as const })
  assert.deepEqual(bridge.report(), { state: 'off' })
  const elsewhere = new IMessageBridge({ stateDir: context.directory, supported: false, paused: () => false,
    deliver: async () => { throw new Error('never') }, onReportChanged: () => undefined })
  elsewhere.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'assistant' as const })
  assert.equal(elsewhere.report(), undefined)
  assert.deepEqual(await elsewhere.send({ to: '+447700900001', text: 'x' }),
    { ok: false, code: 'IMESSAGE_OFF', message: 'iMessage is switched off for this computer in Nessie.' })
})

test('switching on delivers what arrived since, not the history, and the cursor holds what Nessie stored', async (t) => {
  const context = await setUp(t)
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'assistant' as const })
  await context.bridge.idle()
  assert.deepEqual(context.delivered.map((batch) => batch.map((message) => message.guid)), [['g-1', 'g-2']])
  assert.deepEqual(context.cursor(), { since: SINCE, rowId: 3 })
  assert.equal(context.bridge.report()?.state, 'ready')
  assert.ok(context.bridge.report()?.lastDeliveredAt)

  // A batch Nessie did not store in full leaves the cursor where it was.
  insertMessage(context.fixture, { guid: 'g-3', text: 'Still there?', handle: 1, chat: 1, at: '2026-11-11T09:30:00Z' })
  context.setStored(() => [])
  context.bridge.kick()
  await context.bridge.idle()
  assert.deepEqual(context.cursor(), { since: SINCE, rowId: 3 })
  context.setStored((messages) => messages.map((message) => message.guid))
  context.bridge.kick()
  await context.bridge.idle()
  assert.deepEqual(context.delivered.at(-1)?.map((message) => message.guid), ['g-3'])
  assert.deepEqual(context.cursor(), { since: SINCE, rowId: 4 })
})

test('a pause holds delivery until the owner resumes', async (t) => {
  const context = await setUp(t)
  context.setPaused(true)
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'assistant' as const })
  await context.bridge.idle()
  assert.equal(context.delivered.length, 0)
  context.setPaused(false)
  context.bridge.kick()
  await context.bridge.idle()
  assert.equal(context.delivered.length, 1)
})

test('a refused Automation permission is reported and refuses a send with its remedy', async (t) => {
  const context = await setUp(t)
  context.probes.splice(0, 1, { ok: false, failure: 'automation', detail: 'Not authorized (-1743)' })
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'assistant' as const })
  await context.bridge.idle()
  assert.equal(context.bridge.report()?.state, 'needs_automation')
  // Reading still works without it.
  assert.equal(context.delivered.length, 1)
  context.setSendOutcome({ ok: false, failure: 'automation', detail: 'Not authorized (-1743)' })
  const refused = await context.bridge.send({ to: '+447700900001', text: 'Hello' })
  assert.equal(refused.ok, false)
  assert.equal(!refused.ok && refused.code, 'IMESSAGE_SENDS_FROM_OTHER_ADDRESS', 'no evidence of the address yet')
  proveAddress(context.fixture)
  const refusedByMacOS = await context.bridge.send({ to: '+447700900001', text: 'Hello' })
  assert.equal(!refusedByMacOS.ok && refusedByMacOS.code, 'IMESSAGE_NEEDS_AUTOMATION')
})

test('a send returns the guid Messages recorded', async (t) => {
  const context = await setUp(t)
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'assistant' as const })
  await context.bridge.idle()
  proveAddress(context.fixture)
  const sent = await context.bridge.send({ to: '+447700900001', text: 'On my way' })
  assert.deepEqual(sent, { ok: true, result: { sent: true, to: '+447700900001', messageGuid: 'sent-1', from: OWN } })
  assert.deepEqual(context.sends, [['+447700900001', 'On my way']])
  // A send that worked never reads as a missing sign-in.
  assert.equal(context.bridge.report()?.state, 'ready')
})

test('a database macOS will not open reads as missing Full Disk Access', async (t) => {
  const context = await setUp(t)
  const bridge = new IMessageBridge({
    stateDir: context.directory, supported: true, databasePath: join(context.directory, 'chat.db'),
    paused: () => false, deliver: async () => ({ stored: [], switch: { enabled: true, since: SINCE, address: OWN, mode: 'assistant' as const } }),
    onReportChanged: () => undefined, watchFolder: () => () => undefined,
    cursor: { load: async () => null, save: async () => undefined },
    openDatabase: () => { throw new ChatDatabaseError('not_permitted', 'refused') },
    messages: { probe: async () => ({ ok: true, output: '1' }), send: async () => ({ ok: true, output: '' }) },
  })
  t.after(() => bridge.stop())
  bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'assistant' as const })
  await bridge.idle()
  assert.equal(bridge.report()?.state, 'needs_full_disk_access')
  const refused = await bridge.send({ to: '+447700900001', text: 'Hello' })
  assert.equal(!refused.ok && refused.code, 'IMESSAGE_NEEDS_FULL_DISK_ACCESS')
})


test('AppleScript failures name their remedy, and the address and text travel as argv', async () => {
  assert.equal(classifyScriptFailure('execution error: Not authorized to send Apple events to Messages. (-1743)'), 'automation')
  assert.equal(classifyScriptFailure('execution error: Can’t get account 1 whose service type = iMessage. (-1728)'), 'account')
  assert.equal(classifyScriptFailure('execution error: something else (-10000)'), 'failed')
  const calls: string[][] = []
  const app = createMessagesApp(async (args) => {
    calls.push([...args])
    return { code: 0, stdout: '2\n', stderr: '' }
  })
  assert.deepEqual(await app.probe(), { ok: true, output: '2' })
  await app.send('+447700900001', '"; do shell script "rm -rf ~" --')
  const send = calls[1]!
  assert.deepEqual(send.slice(-2), ['+447700900001', '"; do shell script "rm -rf ~" --'])
  assert.ok(send.slice(0, -2).every((part, index) => index % 2 === 0 ? part === '-e' : !part.includes('rm -rf')))
})

test('addresses list phone numbers first, once each, in one spelling', () => {
  assert.deepEqual(orderedAddresses(['Me@iCloud.com', 'tel:+447700900500', '+44 7700 900501', 'me@icloud.com']), [
    { address: '+447700900500', kind: 'phone' }, { address: '+447700900501', kind: 'phone' },
    { address: 'me@icloud.com', kind: 'email' },
  ])
})

test('only a Mac offers imessage.send', () => {
  assert.deepEqual(withHostIMessageOperation(['file.list'], 'macos'), ['file.list', 'imessage.send'])
  assert.deepEqual(withHostIMessageOperation(['file.list', 'imessage.send'], 'macos'), ['file.list', 'imessage.send'])
  assert.deepEqual(withHostIMessageOperation(['file.list', 'imessage.send'], 'windows'), ['file.list'])
  assert.deepEqual(withHostIMessageOperation(['file.list'], 'linux'), ['file.list'])
})

test('Clients mode mirrors the chat, the owner’s own messages included, and reports the addresses', async (t) => {
  const context = await setUp(t)
  insertMessage(context.fixture, { guid: 'mine', text: 'On it', handle: 1, chat: 1, fromMe: true,
    at: '2026-11-11T09:20:00Z', own: 'tel:' + OWN })
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'clients' })
  await context.bridge.idle()
  const delivered = context.delivered.flat()
  assert.deepEqual(delivered.map((message) => [message.guid, message.fromMe]), [['g-1', false], ['g-2', false], ['mine', true]])
  assert.equal(delivered[2]?.sender, OWN)
  assert.equal(delivered[2]?.conversation.id, '+447700900001')
  assert.deepEqual(context.bridge.report()?.addresses, [{ address: OWN, kind: 'phone' }, { address: 'me@example.com', kind: 'email' }])
})

test('a send Messages would make from another address is refused, and the state says so', async (t) => {
  const context = await setUp(t)
  // The owner began a chat from their other number, so new conversations start there.
  insertMessage(context.fixture, { guid: 'began', text: 'Hi', handle: 2, chat: 2, fromMe: true,
    at: '2026-11-11T09:15:00Z', own: '+447700900777' })
  context.fixture.prepare('INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) VALUES (?, ?, ?, ?, ?)')
    .run('iMessage;-;bob@example.com', 45, 'bob@example.com', 'iMessage', '')
  context.fixture.prepare('UPDATE chat_message_join SET chat_id = 3 WHERE message_id = (SELECT MAX(ROWID) FROM message)').run()
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'assistant' })
  await context.bridge.idle()
  assert.equal(context.bridge.report()?.state, 'sends_from_other_address')
  assert.equal(context.bridge.report()?.newConversationsFrom, '+447700900777')
  const refused = await context.bridge.send({ to: 'new@example.com', text: 'Hello' })
  assert.equal(!refused.ok && refused.code, 'IMESSAGE_SENDS_FROM_OTHER_ADDRESS')
  assert.deepEqual(context.sends, [])
})

test('a Clients reply from the outbox is sent once and reported until Nessie settles it', async (t) => {
  const context = await setUp(t)
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'clients' })
  await context.bridge.idle()
  proveAddress(context.fixture)
  const reports: string[][] = []
  context.setReportSent(async (results) => {
    reports.push(results.map((result) => `${result.id}:${result.outcome}`))
    return results.map((result) => result.id)
  })
  const item = { id: '11111111-1111-4111-8111-111111111111', to: '+447700900001', text: 'From Clients' }
  context.bridge.sendOutbox([item])
  context.bridge.sendOutbox([item])
  await context.bridge.repliesIdle()
  assert.deepEqual(context.sends, [['+447700900001', 'From Clients']])
  assert.deepEqual(reports, [[`${item.id}:sent`]])
})

test('with no evidence of the address Messages sends from, nothing is sent', async (t) => {
  const context = await setUp(t)
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'assistant' })
  await context.bridge.idle()
  // Nobody was ever written to from this Mac, so where a new conversation starts is unknown.
  const unknown = await context.bridge.send({ to: 'new@example.com', text: 'Hello' })
  assert.equal(!unknown.ok && unknown.code, 'IMESSAGE_SENDS_FROM_OTHER_ADDRESS')
  assert.match(!unknown.ok ? unknown.message : '', /has not yet shown which address/u)
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: null, mode: 'assistant' })
  proveAddress(context.fixture)
  const unchosen = await context.bridge.send({ to: '+447700900001', text: 'Hello' })
  assert.equal(!unchosen.ok && unchosen.code, 'IMESSAGE_SENDS_FROM_OTHER_ADDRESS')
  assert.deepEqual(context.sends, [])
})

test('a send Messages never answered is looked up in chat.db and never called a failure', async (t) => {
  const stopped = createMessagesApp(async () => ({ code: null, stdout: '', stderr: '', stopped: true }))
  assert.deepEqual(await stopped.send('+447700900001', 'Hi'),
    { ok: false, failure: 'unknown', detail: 'Messages did not answer in time.' })
  const context = await setUp(t)
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'clients' })
  await context.bridge.idle()
  proveAddress(context.fixture)
  context.setSendOutcome({ ok: false, failure: 'unknown', detail: 'Messages did not answer in time.' })
  context.setRecorded(true)
  assert.deepEqual(await context.bridge.send({ to: '+447700900001', text: 'Late' }),
    { ok: true, result: { sent: true, to: '+447700900001', messageGuid: 'sent-1', from: OWN } })
  context.setRecorded(false)
  const uncertain = await context.bridge.send({ to: '+447700900001', text: 'Later' })
  assert.equal(!uncertain.ok && uncertain.code, 'IMESSAGE_SEND_UNCERTAIN')
  const reports: string[] = []
  context.setReportSent(async (results) => {
    reports.push(...results.map((result) => `${result.id}:${result.outcome}`))
    return results.map((result) => result.id)
  })
  const item = { id: '22222222-2222-4222-8222-222222222222', to: '+447700900001', text: 'From Clients' }
  context.bridge.sendOutbox([item])
  await context.bridge.repliesIdle()
  assert.deepEqual(reports, [`${item.id}:unknown`])
})

test('a report that fails holds back only its own reply, and is tried again next heartbeat', async (t) => {
  const context = await setUp(t)
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'clients' })
  await context.bridge.idle()
  proveAddress(context.fixture)
  const first = { id: '33333333-3333-4333-8333-333333333331', to: '+447700900001', text: 'One' }
  const second = { id: '33333333-3333-4333-8333-333333333332', to: '+447700900001', text: 'Two' }
  const reported: string[] = []
  let refusals = 1
  context.setReportSent(async (results) => {
    if (results.some((result) => result.id === first.id) && refusals-- > 0) throw new Error('Nessie said 500')
    reported.push(...results.map((result) => result.id))
    return results.map((result) => result.id)
  })
  context.bridge.sendOutbox([first, second])
  await context.bridge.repliesIdle()
  assert.deepEqual(reported, [second.id])
  // The next heartbeat answer carries no replies; the one still owed is reported anyway.
  context.bridge.sendOutbox(undefined)
  await context.bridge.repliesIdle()
  assert.deepEqual(reported, [second.id, first.id])
  assert.deepEqual(context.sends.map(([, text]) => text), ['One', 'Two'])
})

test('a reply the Mac cannot send fails alone, reported as refused, counted as the server counts', async (t) => {
  // UTF-16 code units, on Nessie and on the Mac alike: an emoji counts as two.
  assert.equal(ExecutorIMessageSendTextSchema.safeParse('😀'.repeat(2_000)).success, true)
  assert.equal(ExecutorIMessageSendTextSchema.safeParse('😀'.repeat(2_001)).success, false)
  const context = await setUp(t)
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'clients' })
  await context.bridge.idle()
  proveAddress(context.fixture)
  const results: Array<{ id: string; outcome: string; code?: string }> = []
  context.setReportSent(async (batch) => {
    results.push(...batch.map((result) => ({ id: result.id, outcome: result.outcome,
      ...(result.outcome === 'refused' ? { code: result.code } : {}) })))
    return batch.map((result) => result.id)
  })
  const tooLong = { id: '44444444-4444-4444-8444-444444444441', to: '+447700900001', text: '😀'.repeat(2_001) }
  const fine = { id: '44444444-4444-4444-8444-444444444442', to: '+447700900001', text: 'Short' }
  context.bridge.sendOutbox([tooLong, fine, { not: 'a reply' }])
  await context.bridge.repliesIdle()
  assert.deepEqual(context.sends, [['+447700900001', 'Short']])
  assert.deepEqual(results, [
    { id: tooLong.id, outcome: 'refused', code: 'IMESSAGE_SEND_FAILED' },
    { id: fine.id, outcome: 'sent' },
  ])
})

test('a photo Messages has not finished writing is waited for, then delivered', async (t) => {
  const context = await setUp(t)
  // The message row is there; its attachment row is not yet.
  insertMessage(context.fixture, { guid: 'photo', text: null, handle: 1, chat: 1, attachments: 1,
    at: '2026-11-11T09:59:30Z' })
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'assistant' })
  await context.bridge.idle()
  assert.deepEqual(context.delivered.map((batch) => batch.map((message) => message.guid)), [['g-1', 'g-2']])
  assert.deepEqual(context.cursor(), { since: SINCE, rowId: 3 })
  context.fixture.prepare('INSERT INTO attachment (mime_type, uti, transfer_name) VALUES (?, ?, ?)')
    .run('image/jpeg', 'public.jpeg', 'IMG_2.JPG')
  context.fixture.prepare('INSERT INTO message_attachment_join VALUES (4, 1)').run()
  context.bridge.kick()
  await context.bridge.idle()
  assert.deepEqual(context.delivered.at(-1)?.map((message) => [message.guid, message.attachments]),
    [['photo', [{ kind: 'photo', name: 'IMG_2.JPG' }]]])
  assert.deepEqual(context.cursor(), { since: SINCE, rowId: 4 })
  // One that never finishes is left behind once it is old, so it cannot hold up what follows.
  insertMessage(context.fixture, { guid: 'never', text: null, handle: 1, chat: 1, at: '2026-11-11T09:40:00Z' })
  insertMessage(context.fixture, { guid: 'after', text: 'Next', handle: 1, chat: 1, at: '2026-11-11T09:59:40Z' })
  context.bridge.kick()
  await context.bridge.idle()
  assert.deepEqual(context.delivered.at(-1)?.map((message) => message.guid), ['after'])
  assert.deepEqual(context.cursor(), { since: SINCE, rowId: 6 })
})
