import { z } from 'zod'

import { TimestampSchema } from './schema-primitives.js'

/**
 * iMessage on a Mac (docs/imessage.md). While the owner of a private macOS
 * computer has switched iMessage on in Nessie, the daemon reads the iMessages
 * that reach that Mac's Messages app from `~/Library/Messages/chat.db` and
 * hands them to Nessie, and an agent acting for that owner may send one
 * through Messages (`imessage.send`). Nothing here is offered on Windows or
 * Linux: the daemon never reports the field there, and Nessie never shows it.
 *
 * Three facts decide whether it works, and each is somebody else's:
 *
 * - Nessie's switch, which only the computer's pairing owner can turn on. It
 *   reaches the daemon as the heartbeat answer's `imessage`.
 * - macOS Full Disk Access for Nessie Computer, to read `chat.db`.
 * - macOS Automation permission for Nessie Computer to control Messages, to
 *   send. macOS asks the person at the Mac the first time.
 *
 * The daemon reports which of them is missing as its `state`; it never
 * pretends to work without them.
 */

/** What the Mac reports about iMessage, each naming its remedy. */
export const EXECUTOR_IMESSAGE_STATES = [
  /** Nessie's switch is off; the daemon reads and sends nothing. */
  'off',
  /** Reading works and Messages answered with a signed-in iMessage account. */
  'ready',
  /** `chat.db` cannot be opened: Full Disk Access is not granted to Nessie Computer. */
  'needs_full_disk_access',
  /** macOS refused Nessie Computer control of Messages (Automation). */
  'needs_automation',
  /** Messages has no enabled iMessage account, or has never been set up on this Mac. */
  'messages_not_signed_in',
  /**
   * Messages starts new conversations from another of the account's addresses
   * than the one the owner chose in Nessie ("Start new conversations from" in
   * Messages settings), so a send would not come from the chosen address.
   */
  'sends_from_other_address',
] as const
export const ExecutorIMessageStateSchema = z.enum(EXECUTOR_IMESSAGE_STATES)
export type ExecutorIMessageState = z.infer<typeof ExecutorIMessageStateSchema>

/** One of the account's addresses. */
export const ExecutorIMessageAddressSchema = z.object({
  address: z.string().min(3).max(254),
  kind: z.enum(['phone', 'email']),
}).strict()
export type ExecutorIMessageAddress = z.infer<typeof ExecutorIMessageAddressSchema>

/**
 * The heartbeat's `imessage` field. A macOS daemon sends it only after a
 * heartbeat answer carried `imessage`, so an older Nessie, which parses the
 * heartbeat strictly, is never sent a field it would refuse. Like every
 * optional heartbeat field it joins the signed payload exactly when present.
 */
export const ExecutorIMessageReportSchema = z.object({
  state: ExecutorIMessageStateSchema,
  /** When the daemon last handed Nessie a message it accepted, if ever. */
  lastDeliveredAt: TimestampSchema.optional(),
  /** The addresses the Mac's iMessage account can be reached at, phone numbers first. */
  addresses: z.array(ExecutorIMessageAddressSchema).max(20).optional(),
  /**
   * The address Messages last started a new conversation from, read from the
   * owner's own sent messages in `chat.db`; absent when it never has.
   */
  newConversationsFrom: z.string().max(254).optional(),
}).strict()
export type ExecutorIMessageReport = z.infer<typeof ExecutorIMessageReportSchema>

/**
 * The heartbeat answer's `imessage` field, present for a macOS executor.
 * `since` is when the owner last switched it on: messages older than that are
 * never delivered, so turning it on does not import the Mac's history.
 */
export const ExecutorIMessageSwitchSchema = z.object({
  enabled: z.boolean(),
  since: TimestampSchema.nullable(),
  /** The owner's chosen address: the channel's identity and the address sends must come from. */
  address: z.string().max(254).nullable(),
  /**
   * `clients`: an owner-only Clients channel, so the owner's own messages are
   * delivered too and the thread mirrors the Messages chat. `assistant`: only
   * other people's messages, into the owner's Personal Assistant home.
   */
  mode: z.enum(['clients', 'assistant']),
}).strict()
export type ExecutorIMessageSwitch = z.infer<typeof ExecutorIMessageSwitchSchema>

/** The signed exchange that hands Nessie newly received messages. */
export const EXECUTOR_DAEMON_IMESSAGE_PATH = '/api/executor-daemon/imessage/messages'
/** Domain of its signature (`canonicalExecutorPayload`), over the body without `signature`. */
export const EXECUTOR_DAEMON_IMESSAGE_SIGNATURE_DOMAIN = 'nessie.executor.daemon.imessage.v1'
/** At most this many messages in one request. */
export const EXECUTOR_IMESSAGE_BATCH_MAXIMUM = 50
/** Text beyond this many characters is cut, and the message says so. */
export const EXECUTOR_IMESSAGE_TEXT_MAXIMUM = 8_000
/** A Mac back from a long sleep delivers at most this far back. */
export const EXECUTOR_IMESSAGE_CATCH_UP_DAYS = 7

/** An iMessage address: an E.164 phone number or an email address, as Messages stores it. */
export const ExecutorIMessageHandleSchema = z.string().trim().min(3).max(254)
  // An address never starts with `-`, so `osascript` cannot read it as an option.
  .regex(/^(?:\+[1-9]\d{6,14}|[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+)$/u,
    'An iMessage address is a phone number in international form (+447700900123) or an email address.')

/**
 * A received attachment, as a placeholder only. The bytes stay on the Mac:
 * Nessie shows "Photo" or the file's name, never its contents.
 */
export const ExecutorIMessageAttachmentSchema = z.object({
  kind: z.enum(['photo', 'video', 'audio', 'file']),
  name: z.string().max(200).nullable(),
}).strict()
export type ExecutorIMessageAttachment = z.infer<typeof ExecutorIMessageAttachmentSchema>

/** One received message. `guid` is Messages' own id, which Nessie deduplicates on. */
export const ExecutorIMessageIncomingSchema = z.object({
  guid: z.string().min(1).max(128),
  receivedAt: TimestampSchema,
  /** The sender's address as Messages knows it; for the owner's own message, the address it went from. */
  sender: z.string().min(1).max(254),
  /** The owner wrote it (on this Mac or another of their devices). Delivered only in Clients mode. */
  fromMe: z.boolean(),
  /** Which of the owner's addresses it reached, or went from; null when Messages did not record one. */
  ownAddress: z.string().max(254).nullable(),
  conversation: z.object({
    /** Messages' chat identifier: the other person's address, or `chat…` for a group. */
    id: z.string().min(1).max(254),
    group: z.boolean(),
    /** A group's name, when somebody gave it one. */
    name: z.string().max(200).nullable(),
  }).strict(),
  text: z.string().max(EXECUTOR_IMESSAGE_TEXT_MAXIMUM),
  /** Whether `text` was cut at {@link EXECUTOR_IMESSAGE_TEXT_MAXIMUM}. */
  truncated: z.boolean(),
  attachments: z.array(ExecutorIMessageAttachmentSchema).max(20),
}).strict()
export type ExecutorIMessageIncoming = z.infer<typeof ExecutorIMessageIncomingSchema>

export const ExecutorDaemonIMessageRequestSchema = z.object({
  connectionEpoch: z.string().regex(/^\d+$/u),
  executorId: z.string().uuid(),
  observedAt: TimestampSchema,
  messages: z.array(ExecutorIMessageIncomingSchema).min(1).max(EXECUTOR_IMESSAGE_BATCH_MAXIMUM)
    .refine((messages) => new Set(messages.map((message) => message.guid)).size === messages.length,
      'Each message appears once.'),
  signature: z.string().min(64).max(256),
}).strict()
export type ExecutorDaemonIMessageRequest = z.infer<typeof ExecutorDaemonIMessageRequestSchema>

/**
 * `stored` are the messages now in Nessie, including those it already had.
 * The daemon moves its cursor past a batch only when every message in it is
 * stored. `switch` is the switch as it stands, so a daemon learns at once
 * that the owner turned it off.
 */
export const ExecutorDaemonIMessageResponseSchema = z.object({
  stored: z.array(z.string().min(1).max(128)).max(EXECUTOR_IMESSAGE_BATCH_MAXIMUM),
  switch: ExecutorIMessageSwitchSchema,
}).strict()
export type ExecutorDaemonIMessageResponse = z.infer<typeof ExecutorDaemonIMessageResponseSchema>

/**
 * The longest text Nessie sends through a Mac, counted in UTF-16 code units —
 * JavaScript's `length`, where an emoji counts as two. Nessie checks a Clients
 * reply against {@link ExecutorIMessageSendTextSchema} before claiming it, and
 * the Mac checks the same schema, so neither side accepts what the other refuses.
 */
export const EXECUTOR_IMESSAGE_SEND_TEXT_MAXIMUM = 4_000
export const ExecutorIMessageSendTextSchema = z.string().trim().min(1).max(EXECUTOR_IMESSAGE_SEND_TEXT_MAXIMUM)

/**
 * `imessage.send`: one text to one address. Whether the owner must approve a
 * first message to somebody new is Nessie's decision, made before the command
 * exists (docs/imessage.md); the Mac sends what reaches it.
 */
export const ExecutorIMessageSendArgumentsSchema = z.object({
  to: ExecutorIMessageHandleSchema,
  text: ExecutorIMessageSendTextSchema,
}).strict()
export type ExecutorIMessageSendArguments = z.infer<typeof ExecutorIMessageSendArgumentsSchema>

/**
 * The send's result. `messageGuid` is the sent message as Messages recorded
 * it; null when Messages accepted the message but it did not appear in
 * `chat.db` within a few seconds, so delivery is not confirmed.
 */
export const ExecutorIMessageSendResultSchema = z.object({
  sent: z.literal(true),
  to: z.string(),
  messageGuid: z.string().max(128).nullable(),
  /** The address Messages actually sent from, as `chat.db` recorded it; null when it was not confirmed. */
  from: z.string().max(254).nullable(),
}).strict()
export type ExecutorIMessageSendResult = z.infer<typeof ExecutorIMessageSendResultSchema>

/** Why the Mac did not send, each naming what the owner can do about it. */
export const EXECUTOR_IMESSAGE_SEND_ERROR_CODES = [
  'IMESSAGE_OFF',
  'IMESSAGE_NEEDS_FULL_DISK_ACCESS',
  'IMESSAGE_NEEDS_AUTOMATION',
  'IMESSAGE_NOT_SIGNED_IN',
  /** Messages would send from another address than the chosen one; nothing was sent. */
  'IMESSAGE_SENDS_FROM_OTHER_ADDRESS',
  'IMESSAGE_SEND_FAILED',
  /**
   * Messages was stopped before it answered (a timeout), and `chat.db` does not
   * show the message: it may or may not have gone. Never resent.
   */
  'IMESSAGE_SEND_UNCERTAIN',
] as const
export type ExecutorIMessageSendErrorCode = (typeof EXECUTOR_IMESSAGE_SEND_ERROR_CODES)[number]

/**
 * A Clients reply the owner pressed Send on (docs/imessage.md → "Clients
 * replies"). A person's Send has no agent run, which every executor command
 * needs, so it reaches the Mac as one item in the heartbeat answer's
 * `imessageOutbox`, handed over once and never again. The Mac sends it with
 * the same send `imessage.send` uses, and reports back at
 * {@link EXECUTOR_DAEMON_IMESSAGE_SENT_PATH}.
 */
export const ExecutorIMessageOutboxItemSchema = z.object({
  id: z.string().uuid(),
  to: ExecutorIMessageHandleSchema,
  text: ExecutorIMessageSendTextSchema,
}).strict()
export type ExecutorIMessageOutboxItem = z.infer<typeof ExecutorIMessageOutboxItemSchema>
export const EXECUTOR_IMESSAGE_OUTBOX_MAXIMUM = 10

/**
 * An outbox item as the heartbeat answer carries it: loose enough that no
 * reply's content can fail the whole heartbeat. The Mac checks each item on
 * its own against {@link ExecutorIMessageOutboxItemSchema} and reports one it
 * cannot send as refused, so a bad item fails alone.
 */
export const ExecutorIMessageOutboxWireItemSchema = z.object({
  id: z.string().uuid(),
  to: z.string().max(2_048),
  text: z.string().max(100_000),
}).strict()

export const EXECUTOR_DAEMON_IMESSAGE_SENT_PATH = '/api/executor-daemon/imessage/sent'
/** Domain of its signature, over the body without `signature`. */
export const EXECUTOR_DAEMON_IMESSAGE_SENT_SIGNATURE_DOMAIN = 'nessie.executor.daemon.imessage_sent.v1'

export const ExecutorIMessageOutboxResultSchema = z.discriminatedUnion('outcome', [
  z.object({ id: z.string().uuid(), outcome: z.literal('sent'), messageGuid: z.string().max(128).nullable(),
    from: z.string().max(254).nullable() }).strict(),
  z.object({ id: z.string().uuid(), outcome: z.literal('refused'), code: z.enum(EXECUTOR_IMESSAGE_SEND_ERROR_CODES),
    message: z.string().max(500) }).strict(),
  /** Messages did not answer and `chat.db` does not show it: it may or may not have gone, and is never resent. */
  z.object({ id: z.string().uuid(), outcome: z.literal('unknown'), message: z.string().max(500) }).strict(),
])
export type ExecutorIMessageOutboxResult = z.infer<typeof ExecutorIMessageOutboxResultSchema>

export const ExecutorDaemonIMessageSentRequestSchema = z.object({
  connectionEpoch: z.string().regex(/^\d+$/u),
  executorId: z.string().uuid(),
  observedAt: TimestampSchema,
  results: z.array(ExecutorIMessageOutboxResultSchema).min(1).max(EXECUTOR_IMESSAGE_OUTBOX_MAXIMUM),
  signature: z.string().min(64).max(256),
}).strict()
export type ExecutorDaemonIMessageSentRequest = z.infer<typeof ExecutorDaemonIMessageSentRequestSchema>

export const ExecutorDaemonIMessageSentResponseSchema = z.object({
  settled: z.array(z.string().uuid()).max(EXECUTOR_IMESSAGE_OUTBOX_MAXIMUM),
}).strict()
