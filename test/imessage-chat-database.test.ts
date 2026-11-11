import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { attributedBodyText, readableMessageText } from '../src/imessage/attributed-body.js'
import { ChatDatabaseError, openChatDatabase } from '../src/imessage/chat-database.js'
import { archivedBody, createChatDatabase, insertMessage, seedChats } from './imessage-fixture.js'

test('the archived body reads back its text, in both length forms, and malformed archives read as none', () => {
  assert.equal(attributedBodyText(archivedBody('On my way 🚲')), 'On my way 🚲')
  const long = 'x'.repeat(300)
  assert.equal(attributedBodyText(archivedBody(long)), long)
  assert.equal(attributedBodyText(Buffer.from('no archive here')), null)
  assert.equal(attributedBodyText(archivedBody('cut').subarray(0, 90)), null)
  assert.equal(attributedBodyText(null), null)
  assert.equal(readableMessageText(null, archivedBody('￼ look at this')), 'look at this')
  assert.equal(readableMessageText('plain', archivedBody('ignored')), 'plain')
})

test('the reader maps received iMessages and leaves out everything else', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-imessage-db-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'chat.db')
  const fixture = createChatDatabase(path)
  seedChats(fixture)
  insertMessage(fixture, { guid: 'g-old', text: 'Before', handle: 1, chat: 1, at: '2026-11-10T08:00:00Z' })
  insertMessage(fixture, { guid: 'g-1', text: 'Hello there', handle: 1, chat: 1, at: '2026-11-11T09:00:00Z' })
  insertMessage(fixture, { guid: 'g-2', body: archivedBody('From the body'), handle: 2, chat: 2, at: '2026-11-11T09:01:00Z' })
  insertMessage(fixture, { guid: 'g-own', text: 'Mine', handle: 1, chat: 1, fromMe: true, at: '2026-11-11T09:02:00Z' })
  insertMessage(fixture, { guid: 'g-sms', text: 'Relayed', handle: 1, chat: 1, service: 'SMS', at: '2026-11-11T09:03:00Z' })
  insertMessage(fixture, { guid: 'g-tap', text: 'Loved “Hello”', handle: 1, chat: 1, tapback: true, at: '2026-11-11T09:04:00Z' })
  insertMessage(fixture, { guid: 'g-photo', text: '￼', handle: 1, chat: 1, attachments: 2, at: '2026-11-11T09:05:00Z' })
  fixture.prepare('INSERT INTO attachment (mime_type, uti, transfer_name) VALUES (?, ?, ?)').run('image/heic', 'public.heic', 'IMG_1.HEIC')
  fixture.prepare('INSERT INTO attachment (mime_type, uti, transfer_name) VALUES (?, ?, ?)').run('application/pdf', 'com.adobe.pdf', 'Plan.pdf')
  fixture.prepare('INSERT INTO message_attachment_join VALUES (7, 1)').run()
  fixture.prepare('INSERT INTO message_attachment_join VALUES (7, 2)').run()
  fixture.close()

  const database = openChatDatabase(path)
  try {
    assert.equal(database.latestRowId(), 7)
    assert.equal(database.rowIdBefore(new Date('2026-11-11T00:00:00Z')), 1)
    const rows = database.scanAfter(1, 50)
    assert.deepEqual(rows.map((row) => row.rowId), [2, 3, 4, 5, 6, 7])
    const incoming = rows.flatMap((row) => row.incoming ? [row.incoming] : [])
    assert.deepEqual(incoming.map((message) => message.guid), ['g-1', 'g-2', 'g-photo'])
    assert.deepEqual(incoming[0], {
      guid: 'g-1', receivedAt: '2026-11-11T09:00:00.000Z', sender: '+447700900001',
      conversation: { id: '+447700900001', group: false, name: null },
      text: 'Hello there', truncated: false, attachments: [],
    })
    assert.deepEqual(incoming[1]?.conversation, { id: 'chat123', group: true, name: 'Climbing' })
    assert.equal(incoming[1]?.text, 'From the body')
    assert.deepEqual(incoming[2]?.attachments, [{ kind: 'photo', name: 'IMG_1.HEIC' }, { kind: 'file', name: 'Plan.pdf' }])
    assert.equal(incoming[2]?.text, '')
    assert.deepEqual(database.sentAfter('+447700900001', 1), { guid: 'g-own', error: 0 })
    assert.equal(database.sentAfter('+447700900001', 4), null)
  } finally {
    database.close()
  }
})

test('a missing database and an unreadable one are told apart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-imessage-missing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  assert.throws(() => openChatDatabase(join(directory, 'chat.db')),
    (error) => error instanceof ChatDatabaseError && error.failure === 'missing')
  // A file that is not a database stands in for one macOS refuses to open.
  const notADatabase = join(directory, 'other.db')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(notADatabase, 'not sqlite')
  assert.throws(() => openChatDatabase(notADatabase),
    (error) => error instanceof ChatDatabaseError && error.failure === 'not_permitted')
})
