import { createRequire } from 'node:module'

export type Database = {
  exec: (sql: string) => void; close: () => void
  prepare: (sql: string) => { run: (...values: (string | number | bigint | Uint8Array | null)[]) => unknown }
}
const sqlite = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => Database }

/** The archived `NSAttributedString` layout Messages writes, around `text`. */
export const archivedBody = (text: string): Uint8Array => {
  const bytes = Buffer.from(text, 'utf8')
  const length = bytes.length < 0x80 ? Buffer.from([bytes.length])
    : Buffer.from([0x81, bytes.length & 0xff, bytes.length >> 8])
  return Buffer.concat([
    Buffer.from('040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67'
      + '008484084e534f626a6563740085928484840' + '84e53537472696e67019484012b', 'hex'),
    length, bytes, Buffer.from('8684026949010292', 'hex'),
  ])
}

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
export const appleNanoseconds = (iso: string): bigint => BigInt(Date.parse(iso) - APPLE_EPOCH_MS) * 1_000_000n

/** The tables and columns of `chat.db` the reader uses, in Messages' own names. */
export const createChatDatabase = (path: string): Database => {
  const database = new sqlite.DatabaseSync(path)
  database.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, style INTEGER, chat_identifier TEXT,
      service_name TEXT, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, text TEXT, attributedBody BLOB,
      handle_id INTEGER, service TEXT, date INTEGER, is_from_me INTEGER, item_type INTEGER DEFAULT 0,
      associated_message_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, error INTEGER DEFAULT 0,
      destination_caller_id TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, mime_type TEXT, uti TEXT, transfer_name TEXT,
      hide_attachment INTEGER DEFAULT 0);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `)
  return database
}

export type MessageRow = {
  guid: string; text?: string | null; body?: Uint8Array | null; handle: number; service?: string; at: string
  fromMe?: boolean; chat: number; itemType?: number; tapback?: boolean; attachments?: number; error?: number
  /** The owner's address it reached or went from (`destination_caller_id`). */
  own?: string
}

export const insertMessage = (database: Database, row: MessageRow): void => {
  database.prepare(`INSERT INTO message (guid, text, attributedBody, handle_id, service, date, is_from_me, item_type,
    associated_message_type, cache_has_attachments, error, destination_caller_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.guid, row.text ?? null, row.body ?? null, row.handle, row.service ?? 'iMessage', appleNanoseconds(row.at),
    row.fromMe ? 1 : 0, row.itemType ?? 0, row.tapback ? 2000 : 0, row.attachments ? 1 : 0, row.error ?? 0,
    row.own ?? null)
  database.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, last_insert_rowid())').run(row.chat)
}

/** Two people, a one-to-one chat with Alice and a named group with both. */
export const seedChats = (database: Database): void => {
  database.prepare('INSERT INTO handle (id, service) VALUES (?, ?)').run('+447700900001', 'iMessage')
  database.prepare('INSERT INTO handle (id, service) VALUES (?, ?)').run('bob@example.com', 'iMessage')
  database.prepare('INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) VALUES (?, ?, ?, ?, ?)')
    .run('iMessage;-;+447700900001', 45, '+447700900001', 'iMessage', '')
  database.prepare('INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) VALUES (?, ?, ?, ?, ?)')
    .run('iMessage;+;chat123', 43, 'chat123', 'iMessage', 'Climbing')
  // Who is in each chat, as Messages records it: Alice alone, then both in the group.
  database.exec('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1), (2, 1), (2, 2)')
}
