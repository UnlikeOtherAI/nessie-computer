import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  EXECUTOR_IMESSAGE_TEXT_MAXIMUM,
  type ExecutorIMessageAttachment,
  type ExecutorIMessageIncoming,
} from '@nessie/executor-protocol'

import { readableMessageText } from './attributed-body.js'
import { normalizeIMessageAddress } from './imessage-addresses.js'

/**
 * Read-only access to Messages' own database, `~/Library/Messages/chat.db`.
 * Opening it needs Full Disk Access; nothing here ever writes to it. Every
 * value from a caller is a bound parameter.
 */
export const defaultChatDatabasePath = (home = homedir()): string => join(home, 'Library', 'Messages', 'chat.db')

type Statement = {
  all: (...parameters: unknown[]) => Record<string, unknown>[]
  get: (...parameters: unknown[]) => Record<string, unknown> | undefined
}
type Database = { exec: (sql: string) => void; prepare: (sql: string) => Statement; close: () => void }
type SqliteModule = { DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database }

/** Why the database could not be read. */
export type ChatDatabaseFailure = 'not_permitted' | 'missing'

export class ChatDatabaseError extends Error {
  constructor(readonly failure: ChatDatabaseFailure, message: string) {
    super(message)
    this.name = 'ChatDatabaseError'
  }
}

/** Seconds from the Unix epoch to Apple's (2001-01-01T00:00:00Z). */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
/**
 * `message.date` in milliseconds since Apple's epoch. Since macOS 10.13 the
 * column holds nanoseconds; older rows hold seconds. Dividing inside SQLite
 * keeps the nanosecond integer out of JavaScript's floating point.
 */
const APPLE_MS = 'CASE WHEN m.date > 100000000000000 THEN m.date / 1000000 ELSE m.date * 1000 END'

/** One scanned row. `incoming` is null for rows that are not an iMessage a person wrote (and, unless asked for, the owner's own). */
export type ScannedRow = { rowId: number; incoming: ExecutorIMessageIncoming | null }

export type ChatDatabase = {
  /** The newest message's row id, or 0 for an empty database. */
  latestRowId: () => number
  /** The newest row id of a message dated before `at`, or 0: where delivery starts for a switch turned on at `at`. */
  rowIdBefore: (at: Date) => number
  /** Up to `limit` rows after `afterRowId`, oldest first; `includeOwn` maps the owner's own messages too. */
  scanAfter: (afterRowId: number, limit: number, includeOwn?: boolean) => ScannedRow[]
  /** The owner's newest message to `handle` after `afterRowId`: its guid, Messages' error code and the address it went from. */
  sentAfter: (handle: string, afterRowId: number) => { guid: string; error: number; from: string | null } | null
  /** The address the owner's last message to `handle` in their one-to-one chat went from; null without one. */
  sendingAddressFor: (handle: string) => string | null
  /**
   * The address Messages last started a new conversation from: the first message
   * of the newest one-to-one iMessage chat the owner began. Messages keeps its
   * "Start new conversations from" setting nowhere a program can read, so this
   * is the evidence of what it did; null when the owner never began one here.
   */
  newConversationsFrom: () => string | null
  close: () => void
}

const loadSqlite = (): SqliteModule =>
  createRequire(join(homedir(), 'nessie-imessage.cjs'))('node:sqlite') as SqliteModule

export const openChatDatabase = (
  path = defaultChatDatabasePath(), sqlite: SqliteModule = loadSqlite(),
): ChatDatabase => {
  // Without Full Disk Access macOS refuses even a stat of the file (EPERM);
  // only ENOENT means Messages has never kept a database on this Mac.
  try {
    statSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw code === 'ENOENT'
      ? new ChatDatabaseError('missing', 'Messages has no database on this Mac.')
      : new ChatDatabaseError('not_permitted', 'Nessie Computer may not read the Messages database.')
  }
  let database: Database | undefined
  try {
    database = new sqlite.DatabaseSync(path, { readOnly: true })
    database.exec('PRAGMA busy_timeout = 2000')
    // Opening is lazy: the first read is what a refused permission fails.
    database.prepare('SELECT MAX(ROWID) AS id FROM message').get()
  } catch {
    database?.close()
    throw new ChatDatabaseError('not_permitted', 'Nessie Computer may not read the Messages database.')
  }
  return chatDatabaseOver(database)
}

const chatDatabaseOver = (database: Database): ChatDatabase => {
  const latest = database.prepare('SELECT IFNULL(MAX(ROWID), 0) AS id FROM message')
  const before = database.prepare(`SELECT IFNULL(MAX(m.ROWID), 0) AS id FROM message m WHERE ${APPLE_MS} < ?`)
  const scan = database.prepare(`
    SELECT m.ROWID AS rowId, m.guid AS guid, m.text AS text, m.attributedBody AS body,
      ${APPLE_MS} AS appleMs, m.is_from_me AS fromMe, m.service AS service,
      m.item_type AS itemType, m.associated_message_type AS associatedType,
      m.cache_has_attachments AS hasAttachments, h.id AS sender, m.destination_caller_id AS ownAddress,
      c.chat_identifier AS chatId, c.display_name AS chatName, c.style AS chatStyle
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    LEFT JOIN chat c ON c.ROWID = (SELECT chat_id FROM chat_message_join WHERE message_id = m.ROWID LIMIT 1)
    WHERE m.ROWID > ? ORDER BY m.ROWID LIMIT ?`)
  const attachments = database.prepare(`
    SELECT a.mime_type AS mime, a.uti AS uti, a.transfer_name AS name
    FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id
    WHERE j.message_id = ? AND IFNULL(a.hide_attachment, 0) = 0 ORDER BY a.ROWID LIMIT 20`)
  const sent = database.prepare(`
    SELECT m.guid AS guid, m.error AS error, m.destination_caller_id AS ownAddress
    FROM message m JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.ROWID > ? AND m.is_from_me = 1 AND h.id = ? COLLATE NOCASE
    ORDER BY m.ROWID DESC LIMIT 1`)
  const lastFrom = database.prepare(`
    SELECT m.destination_caller_id AS ownAddress FROM chat c
    JOIN chat_handle_join ch ON ch.chat_id = c.ROWID JOIN handle h ON h.ROWID = ch.handle_id
    JOIN chat_message_join cm ON cm.chat_id = c.ROWID JOIN message m ON m.ROWID = cm.message_id
    WHERE c.style = 45 AND c.service_name = 'iMessage' AND h.id = ? COLLATE NOCASE AND m.is_from_me = 1
      AND IFNULL(m.destination_caller_id, '') <> ''
    ORDER BY m.ROWID DESC LIMIT 1`)
  const started = database.prepare(`
    SELECT m.destination_caller_id AS ownAddress FROM chat c
    JOIN message m ON m.ROWID = (SELECT MIN(j.message_id) FROM chat_message_join j WHERE j.chat_id = c.ROWID)
    WHERE c.style = 45 AND c.service_name = 'iMessage' AND m.is_from_me = 1 AND m.service = 'iMessage'
      AND IFNULL(m.destination_caller_id, '') <> ''
    ORDER BY m.ROWID DESC LIMIT 1`)
  const address = (row: Record<string, unknown> | undefined): string | null =>
    typeof row?.ownAddress === 'string' && row.ownAddress ? normalizeIMessageAddress(row.ownAddress) : null
  return {
    latestRowId: () => Number(latest.get()?.id ?? 0),
    rowIdBefore: (at) => Number(before.get(at.getTime() - APPLE_EPOCH_MS)?.id ?? 0),
    scanAfter: (afterRowId, limit, includeOwn = false) => scan.all(afterRowId, limit).map((row) => ({
      rowId: Number(row.rowId),
      incoming: incomingOf(row, () => attachments.all(row.rowId), includeOwn),
    })),
    sentAfter: (handle, afterRowId) => {
      const row = sent.get(afterRowId, handle)
      return row && typeof row.guid === 'string'
        ? { guid: row.guid, error: Number(row.error ?? 0), from: address(row) } : null
    },
    sendingAddressFor: (handle) => address(lastFrom.get(handle)),
    newConversationsFrom: () => address(started.get()),
    close: () => database.close(),
  }
}

/** Group chats have style 43; one-to-one chats 45. */
const GROUP_STYLE = 43

const incomingOf = (
  row: Record<string, unknown>, readAttachments: () => Record<string, unknown>[], includeOwn: boolean,
): ExecutorIMessageIncoming | null => {
  // Only what a person wrote over iMessage: not an SMS or RCS text an iPhone
  // relayed, not a tapback, edit marker or group event; the owner's own only when asked.
  const fromMe = Number(row.fromMe) !== 0
  if ((fromMe && !includeOwn) || row.service !== 'iMessage') return null
  if (Number(row.itemType ?? 0) !== 0 || Number(row.associatedType ?? 0) !== 0) return null
  const ownAddress = typeof row.ownAddress === 'string' && row.ownAddress
    ? normalizeIMessageAddress(row.ownAddress).slice(0, 254) : null
  const sender = fromMe ? ownAddress ?? 'me' : row.sender
  if (typeof row.guid !== 'string' || typeof sender !== 'string' || sender.length === 0) return null
  if (fromMe && typeof row.chatId !== 'string') return null
  const text = readableMessageText(typeof row.text === 'string' ? row.text : null, row.body as Uint8Array | null)
  const found = Number(row.hasAttachments ?? 0) === 1 ? readAttachments().map(attachmentOf) : []
  if (text.length === 0 && found.length === 0) return null
  const group = Number(row.chatStyle) === GROUP_STYLE
  const chatId = typeof row.chatId === 'string' && row.chatId.length > 0 ? row.chatId : sender
  const truncated = text.length > EXECUTOR_IMESSAGE_TEXT_MAXIMUM
  return {
    guid: row.guid.slice(0, 128),
    receivedAt: new Date(APPLE_EPOCH_MS + Number(row.appleMs ?? 0)).toISOString(),
    sender: sender.slice(0, 254),
    fromMe,
    ownAddress,
    conversation: {
      id: chatId.slice(0, 254),
      group,
      name: group && typeof row.chatName === 'string' && row.chatName.trim() ? row.chatName.trim().slice(0, 200) : null,
    },
    text: truncated ? text.slice(0, EXECUTOR_IMESSAGE_TEXT_MAXIMUM) : text,
    truncated,
    attachments: found,
  }
}

const attachmentOf = (row: Record<string, unknown>): ExecutorIMessageAttachment => {
  const mime = typeof row.mime === 'string' ? row.mime.toLowerCase() : ''
  const uti = typeof row.uti === 'string' ? row.uti.toLowerCase() : ''
  const kind = mime.startsWith('image/') || uti.startsWith('public.heic') || uti === 'public.jpeg' ? 'photo'
    : mime.startsWith('video/') ? 'video'
      : mime.startsWith('audio/') || uti.includes('audio') ? 'audio' : 'file'
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 200) : null
  return { kind, name }
}
