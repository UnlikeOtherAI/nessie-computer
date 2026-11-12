import { watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'

import {
  EXECUTOR_IMESSAGE_BATCH_MAXIMUM,
  EXECUTOR_IMESSAGE_CATCH_UP_DAYS,
  ExecutorIMessageSwitchSchema,
  type ExecutorDaemonIMessageResponse,
  type ExecutorIMessageAddress,
  type ExecutorIMessageOutboxResult,
  type ExecutorIMessageIncoming,
  type ExecutorIMessageReport,
  type ExecutorIMessageSendArguments,
  type ExecutorIMessageSendErrorCode,
  type ExecutorIMessageState,
  type ExecutorIMessageSwitch,
} from '@nessie/executor-protocol'

import { ChatDatabaseError, defaultChatDatabasePath, openChatDatabase, type ChatDatabase } from './chat-database.js'
import { loadIMessageCursor, saveIMessageCursor, type IMessageCursor } from './imessage-cursor.js'

/** Where the cursor is kept: the team's owner-only folder, unless a test supplies its own. */
export type IMessageCursorStore = {
  load: () => Promise<IMessageCursor | null>
  save: (cursor: IMessageCursor) => Promise<void>
}
import { normalizeIMessageAddress, readIMessageAddresses, type AddressReader } from './imessage-addresses.js'
import { createMessagesApp, type MessagesApp, type MessagesFailure, type ScriptOutcome } from './messages-script.js'
import { IMessageReplies, type IMessageSendOutcome } from './imessage-replies.js'

export type { IMessageSendOutcome } from './imessage-replies.js'

/** A quiet Mac is still looked at this often, in case a change was not noticed. */
export const IMESSAGE_SWEEP_MS = 30_000
/** While something is missing, Messages is asked again this often, so a permission granted later is seen. */
export const IMESSAGE_REPROBE_MS = 5 * 60_000
/** Rows read per page; one page is at most one delivery. */
const PAGE_ROWS = EXECUTOR_IMESSAGE_BATCH_MAXIMUM
/** Pages per pass; a long backlog continues on the next pass. */
const PAGES_PER_PASS = 40
/** How long a sent message is looked for in `chat.db`: ten looks, half a second apart. */
const SENT_CONFIRM_ATTEMPTS = 10
const SENT_CONFIRM_STEP_MS = 500
const DAY_MS = 86_400_000
/** How long a message Messages has not finished writing (a photo before its attachment row) is waited for. */
export const IMESSAGE_UNFINISHED_WAIT_MS = 2 * 60_000

export type IMessageBridgeOptions = {
  stateDir: string
  /** Only macOS has Messages. Elsewhere the bridge reports nothing and refuses every send. */
  supported: boolean
  deliver: (messages: ExecutorIMessageIncoming[]) => Promise<ExecutorDaemonIMessageResponse>
  /** The owner paused this team on the computer: nothing is read or sent until they resume. */
  paused: () => boolean
  /** Something Nessie should hear changed; the daemon sends a heartbeat. */
  onReportChanged: () => void
  /** Reports what became of the Clients replies the Mac was handed; answers the ids settled. */
  reportSent?: (results: ExecutorIMessageOutboxResult[]) => Promise<string[]>
  databasePath?: string
  openDatabase?: (path: string) => ChatDatabase
  messages?: MessagesApp
  /** The account's addresses (`imessage-addresses.ts`). */
  readAddresses?: AddressReader
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  watchFolder?: (folder: string, onChange: () => void) => (() => void) | null
  cursor?: IMessageCursorStore
}

const watchFolderDefault = (folder: string, onChange: () => void): (() => void) | null => {
  let watcher: FSWatcher
  try {
    watcher = watch(folder, { persistent: false }, onChange)
  } catch {
    return null
  }
  watcher.on('error', () => undefined)
  return () => watcher.close()
}

/**
 * The daemon's half of iMessage on a Mac (docs/imessage.md): it holds Nessie's
 * switch, reports what the Mac lacks, hands received messages to Nessie from a
 * cursor kept on this computer, and sends for `imessage.send`.
 */
export class IMessageBridge {
  private switchState: ExecutorIMessageSwitch | null = null
  private heardFromNessie = false
  private automation: 'unknown' | 'granted' | 'refused' | 'no_account' = 'unknown'
  private databaseState: 'unknown' | 'readable' | 'not_permitted' | 'missing' = 'unknown'
  private lastDeliveredAt: string | undefined
  private lastProbeAt = 0
  private running: Promise<void> | null = null
  private again = false
  private stopWatch: (() => void) | null = null
  private sweep: NodeJS.Timeout | null = null
  private readonly databasePath: string
  private readonly messages: MessagesApp
  private readonly readAddresses: AddressReader
  private addresses: ExecutorIMessageAddress[] = []
  private newConversationsFrom: string | null = null
  private readonly open: (path: string) => ChatDatabase
  private readonly now: () => Date
  private readonly sleep: (ms: number) => Promise<void>
  private readonly cursor: IMessageCursorStore
  private readonly replies: IMessageReplies

  constructor(private readonly options: IMessageBridgeOptions) {
    this.databasePath = options.databasePath ?? defaultChatDatabasePath()
    this.messages = options.messages ?? createMessagesApp()
    this.readAddresses = options.readAddresses ?? (() => readIMessageAddresses())
    this.open = options.openDatabase ?? ((path) => openChatDatabase(path))
    this.now = options.now ?? (() => new Date())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.cursor = options.cursor ?? {
      load: () => loadIMessageCursor(options.stateDir),
      save: (cursor) => saveIMessageCursor(options.stateDir, cursor),
    }
    this.replies = new IMessageReplies({ send: (input) => this.send(input), report: () => this.options.reportSent })
  }

  /** The heartbeat's `imessage`, once Nessie has said it knows the feature; never off a Mac. */
  report(): ExecutorIMessageReport | undefined {
    if (!this.options.supported || !this.heardFromNessie) return undefined
    return {
      state: this.state(),
      ...(this.lastDeliveredAt ? { lastDeliveredAt: this.lastDeliveredAt } : {}),
      ...(this.addresses.length > 0 ? { addresses: this.addresses } : {}),
      ...(this.newConversationsFrom ? { newConversationsFrom: this.newConversationsFrom } : {}),
    }
  }

  state(): ExecutorIMessageState {
    if (!this.switchState?.enabled) return 'off'
    if (this.databaseState === 'not_permitted') return 'needs_full_disk_access'
    if (this.databaseState === 'missing' || this.automation === 'no_account') return 'messages_not_signed_in'
    if (this.automation === 'refused') return 'needs_automation'
    if (this.sendsFromOther(this.newConversationsFrom)) return 'sends_from_other_address'
    return 'ready'
  }

  /** The chosen address, when Messages would send from another one. */
  private sendsFromOther(address: string | null): boolean {
    const chosen = this.switchState?.address
    return Boolean(chosen && address && normalizeIMessageAddress(chosen) !== normalizeIMessageAddress(address))
  }

  /** Nessie's switch, from a heartbeat answer or a delivery answer. Anything malformed is ignored. */
  applySwitch(value: unknown): void {
    if (!this.options.supported || value === undefined) return
    const parsed = ExecutorIMessageSwitchSchema.safeParse(value)
    if (!parsed.success) return
    const before = this.state()
    const wasOn = this.switchState?.enabled === true
    // Only a switch turned on, or turned on again from a new moment, starts a pass:
    // every answer repeats the switch, and a refused batch must wait for the sweep.
    const turnedOn = parsed.data.enabled && (!wasOn || this.switchState?.since !== parsed.data.since)
    this.heardFromNessie = true
    this.switchState = parsed.data
    if (parsed.data.enabled) {
      this.startWatching()
      if (turnedOn) {
        this.lastProbeAt = 0
        this.kick()
      }
    } else {
      this.stopWatching()
    }
    if (this.state() !== before || !wasOn && parsed.data.enabled) this.options.onReportChanged()
  }

  /** Look for new messages now (a change in the Messages folder, a resume, a reconnect). */
  kick(): void {
    if (!this.switchState?.enabled || this.options.paused()) return
    if (this.running) {
      this.again = true
      return
    }
    this.running = this.pass().catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      console.error('[nessie-executor] iMessage delivery stopped for now:', reason)
    }).finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        this.kick()
      }
    })
  }

  /** Waits for a pass in progress; tests and shutdown use it. */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  stop(): void {
    this.stopWatching()
  }

  private startWatching(): void {
    if (!this.sweep) {
      this.sweep = setInterval(() => this.kick(), IMESSAGE_SWEEP_MS)
      this.sweep.unref()
    }
    if (!this.stopWatch) {
      this.stopWatch = (this.options.watchFolder ?? watchFolderDefault)(dirname(this.databasePath), () => this.kick())
    }
  }

  private stopWatching(): void {
    if (this.sweep) clearInterval(this.sweep)
    this.sweep = null
    this.stopWatch?.()
    this.stopWatch = null
  }

  private openDatabase(): ChatDatabase | null {
    try {
      const database = this.open(this.databasePath)
      this.databaseState = 'readable'
      return database
    } catch (error) {
      const missing = error instanceof ChatDatabaseError && error.failure === 'missing'
      this.databaseState = missing ? 'missing' : 'not_permitted'
      return null
    }
  }

  private async probe(force = false): Promise<void> {
    const due = force || this.lastProbeAt === 0
      || this.automation !== 'granted' && this.now().getTime() - this.lastProbeAt >= IMESSAGE_REPROBE_MS
    if (!due) return
    this.lastProbeAt = this.now().getTime()
    this.noteMessages(await this.messages.probe(), 'probe')
  }

  /** A probe answers with the number of enabled iMessage accounts; a send that worked proves both. */
  private noteMessages(outcome: ScriptOutcome, kind: 'probe' | 'send'): void {
    if (outcome.ok && kind === 'send') {
      this.automation = 'granted'
    } else if (outcome.ok) {
      const accounts = Number.parseInt(outcome.output, 10)
      this.automation = Number.isFinite(accounts) && accounts > 0 ? 'granted' : 'no_account'
    } else if (outcome.failure === 'automation') {
      this.automation = 'refused'
    } else if (outcome.failure === 'account') {
      this.automation = 'no_account'
    }
  }

  private async pass(): Promise<void> {
    const before = this.state()
    const database = this.openDatabase()
    try {
      if (database) {
        await this.probe()
        this.addresses = await this.readAddresses()
        this.newConversationsFrom = database.newConversationsFrom()
        await this.deliverFrom(database)
      }
    } finally {
      database?.close()
      if (this.state() !== before) this.options.onReportChanged()
    }
  }

  private async cursorFor(database: ChatDatabase, since: string): Promise<IMessageCursor> {
    const saved = await this.cursor.load()
    if (saved?.since === since) return saved
    const fresh = { since, rowId: database.rowIdBefore(new Date(since)) }
    await this.cursor.save(fresh)
    return fresh
  }

  private async deliverFrom(database: ChatDatabase): Promise<void> {
    for (let page = 0; page < PAGES_PER_PASS; page += 1) {
      const since = this.switchState?.enabled ? this.switchState.since : null
      if (!since || this.options.paused()) return
      const cursor = await this.cursorFor(database, since)
      // In Clients mode the thread mirrors the Messages chat, the owner's own messages included.
      const scanned = database.scanAfter(cursor.rowId, PAGE_ROWS, this.switchState?.mode === 'clients')
      // A recent message Messages has not finished writing stops the page before it: the cursor
      // never passes it, and the next pass reads it again. An old one is left behind.
      const waiting = scanned.findIndex((row) => row.unfinishedAt
        && this.now().getTime() - Date.parse(row.unfinishedAt) < IMESSAGE_UNFINISHED_WAIT_MS)
      const rows = waiting === -1 ? scanned : scanned.slice(0, waiting)
      if (rows.length === 0) return
      const floor = Math.max(Date.parse(since), this.now().getTime() - EXECUTOR_IMESSAGE_CATCH_UP_DAYS * DAY_MS)
      const due = rows.flatMap((row) => row.incoming && Date.parse(row.incoming.receivedAt) >= floor
        ? [row.incoming] : [])
      if (due.length > 0) {
        const answer = await this.options.deliver(due)
        this.applySwitch(answer.switch)
        const stored = new Set(answer.stored)
        // The cursor moves only past a batch Nessie holds in full.
        if (!due.every((message) => stored.has(message.guid))) return
        this.lastDeliveredAt = this.now().toISOString()
      }
      await this.cursor.save({ since, rowId: rows[rows.length - 1]!.rowId })
      if (waiting !== -1 || rows.length < PAGE_ROWS) return
    }
  }

  /** Each heartbeat answer's Clients replies, or none (`imessage-replies.ts`). */
  sendOutbox(value: unknown): void {
    if (this.options.supported) this.replies.receive(value)
  }

  /** Waits for the Clients replies in hand; tests and shutdown use it. */
  repliesIdle(): Promise<void> {
    return this.replies.idle()
  }

  /** `imessage.send`: refuses with a code that names its remedy, never pretends. */
  async send(input: ExecutorIMessageSendArguments): Promise<IMessageSendOutcome> {
    if (!this.options.supported || !this.switchState?.enabled) {
      return refuse('IMESSAGE_OFF', 'iMessage is switched off for this computer in Nessie.')
    }
    const database = this.openDatabase()
    if (!database) {
      this.options.onReportChanged()
      return this.databaseState === 'missing'
        ? refuse('IMESSAGE_NOT_SIGNED_IN', 'Messages is not set up on this Mac.')
        : refuse('IMESSAGE_NEEDS_FULL_DISK_ACCESS',
          'Nessie Computer needs Full Disk Access on this Mac (System Settings › Privacy & Security).')
    }
    try {
      const unproven = this.sendingAddressRefusal(database, input.to)
      if (unproven) return unproven
      const before = database.latestRowId()
      const outcome = await this.messages.send(input.to, input.text)
      const previous = this.state()
      this.noteMessages(outcome, 'send')
      if (this.state() !== previous) this.options.onReportChanged()
      // Stopped before it answered: only chat.db can say whether Messages sent it.
      if (!outcome.ok && outcome.failure === 'unknown') return await this.confirmSent(database, input.to, before, false)
      if (!outcome.ok) return refuseScript(outcome.failure, outcome.detail)
      return await this.confirmSent(database, input.to, before, true)
    } finally {
      database.close()
    }
  }

  /**
   * Fail closed: Messages sends from the chat's own address, or for a chat with
   * no history from the address it starts new conversations from, and neither
   * can be chosen from here. Without evidence of that address, nothing is sent.
   */
  private sendingAddressRefusal(database: ChatDatabase, to: string): IMessageSendOutcome | null {
    const chosen = this.switchState?.address ?? null
    const sendsFrom = database.sendingAddressFor(to) ?? database.newConversationsFrom()
    if (!chosen) {
      return refuse('IMESSAGE_SENDS_FROM_OTHER_ADDRESS',
        'Choose the address iMessage sends from on this computer\'s page in Nessie. Nothing was sent.')
    }
    if (!sendsFrom) {
      return refuse('IMESSAGE_SENDS_FROM_OTHER_ADDRESS', 'Messages on this Mac has not yet shown which address it '
        + `starts new conversations from, so this might not come from ${chosen}. In Messages › Settings › iMessage, `
        + `set "Start new conversations from" to ${chosen} and start one conversation in Messages. Nothing was sent.`)
    }
    if (!this.sendsFromOther(sendsFrom)) return null
    return refuse('IMESSAGE_SENDS_FROM_OTHER_ADDRESS', `Messages on this Mac would send this from ${sendsFrom}, `
      + `not ${chosen}. Change "Start new conversations from" in Messages settings, `
      + 'or choose that address for iMessage in Nessie. Nothing was sent.')
  }

  /**
   * Looks for the message in chat.db. `accepted`: Messages answered the send, so
   * a message not found in time is reported as sent but unconfirmed; otherwise
   * Messages never answered, and one not found may or may not have gone.
   */
  private async confirmSent(
    database: ChatDatabase, to: string, before: number, accepted: boolean,
  ): Promise<IMessageSendOutcome> {
    // Counted, not timed: a fixed or stalled clock can never keep it looping.
    for (let attempt = 0; ; attempt += 1) {
      const sent = database.sentAfter(to, before)
      if (sent && sent.error !== 0) {
        return refuse('IMESSAGE_SEND_FAILED', `Messages could not deliver to ${to} (error ${sent.error}).`)
      }
      if (sent) {
        // What chat.db recorded is what is reported, whatever was chosen; a new
        // conversation it began is fresh evidence of where Messages starts them.
        const previous = this.state()
        this.newConversationsFrom = database.newConversationsFrom()
        if (this.state() !== previous) this.options.onReportChanged()
        return { ok: true, result: { sent: true, to, messageGuid: sent.guid, from: sent.from } }
      }
      if (attempt >= SENT_CONFIRM_ATTEMPTS) {
        return accepted ? { ok: true, result: { sent: true, to, messageGuid: null, from: null } }
          : refuse('IMESSAGE_SEND_UNCERTAIN', 'Messages did not answer in time, and it has not recorded the '
            + 'message. It may or may not have been sent; do not send it again.')
      }
      await this.sleep(SENT_CONFIRM_STEP_MS)
    }
  }
}

const refuse = (code: ExecutorIMessageSendErrorCode, message: string): IMessageSendOutcome =>
  ({ ok: false, code, message })

const refuseScript = (failure: MessagesFailure, detail: string): IMessageSendOutcome => {
  if (failure === 'automation') {
    return refuse('IMESSAGE_NEEDS_AUTOMATION',
      'macOS has not allowed Nessie Computer to control Messages (System Settings › Privacy & Security › Automation).')
  }
  if (failure === 'account') return refuse('IMESSAGE_NOT_SIGNED_IN', 'Messages on this Mac is not signed in to iMessage.')
  return refuse('IMESSAGE_SEND_FAILED', `Messages did not send it: ${detail}`)
}
