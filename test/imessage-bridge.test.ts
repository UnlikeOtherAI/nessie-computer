import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ExecutorIMessageIncoming } from '@nessie/executor-protocol'

import { ChatDatabaseError } from '../src/imessage/chat-database.js'
import { IMessageBridge } from '../src/imessage/imessage-bridge.js'
import type { IMessageCursor } from '../src/imessage/imessage-cursor.js'
import { orderedAddresses } from '../src/imessage/imessage-addresses.js'
import { withHostIMessageOperation } from '../src/imessage/imessage-operation.js'
import { classifyScriptFailure, createMessagesApp, type ScriptOutcome } from '../src/imessage/messages-script.js'
import { createChatDatabase, insertMessage, seedChats } from './imessage-fixture.js'

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
  let stored: (messages: ExecutorIMessageIncoming[]) => string[] = (messages) => messages.map((message) => message.guid)
  let paused = false
  let reports = 0
  const bridge = new IMessageBridge({
    stateDir: directory, supported: true, databasePath, paused: () => paused,
    deliver: async (messages) => {
      delivered.push(messages)
      return { stored: stored(messages), switch: { enabled: true, since: SINCE, address: OWN, mode: 'assistant' as const } }
    },
    onReportChanged: () => { reports += 1 },
    messages: {
      probe: async () => probes.shift() ?? { ok: true, output: '1' },
      send: async (handle, text) => {
        sends.push([handle, text])
        if (sendOutcome.ok) {
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
    setStored: (next: typeof stored) => { stored = next },
    setPaused: (value: boolean) => { paused = value },
    reports: () => reports,
  }
}

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
  assert.equal(!refused.ok && refused.code, 'IMESSAGE_NEEDS_AUTOMATION')
})

test('a send returns the guid Messages recorded', async (t) => {
  const context = await setUp(t)
  context.bridge.applySwitch({ enabled: true, since: SINCE, address: OWN, mode: 'assistant' as const })
  await context.bridge.idle()
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
  const reports: string[][] = []
  ;(context.bridge as unknown as { options: { reportSent: (r: { id: string; outcome: string }[]) => Promise<string[]> } })
    .options.reportSent = async (results) => {
      reports.push(results.map((result) => `${result.id}:${result.outcome}`))
      return results.map((result) => result.id)
    }
  const item = { id: '11111111-1111-4111-8111-111111111111', to: '+447700900001', text: 'From Clients' }
  context.bridge.sendOutbox([item])
  context.bridge.sendOutbox([item])
  await (context.bridge as unknown as { outboxQueue: Promise<void> }).outboxQueue
  assert.deepEqual(context.sends, [['+447700900001', 'From Clients']])
  assert.deepEqual(reports, [[`${item.id}:sent`]])
})
