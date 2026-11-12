import { z } from 'zod'

import {
  EXECUTOR_IMESSAGE_OUTBOX_MAXIMUM,
  ExecutorIMessageOutboxItemSchema,
  type ExecutorIMessageOutboxResult,
  type ExecutorIMessageSendArguments,
  type ExecutorIMessageSendErrorCode,
  type ExecutorIMessageSendResult,
} from '@nessie/executor-protocol'

/**
 * Report attempts per reply before the Mac stops trying. One a heartbeat, so
 * about as long as Nessie waits before it calls a reply uncertain.
 */
export const IMESSAGE_REPORT_ATTEMPTS = 20

export type IMessageSendOutcome =
  | { ok: true; result: ExecutorIMessageSendResult }
  | { ok: false; code: ExecutorIMessageSendErrorCode; message: string }

export type IMessageRepliesOptions = {
  send: (input: ExecutorIMessageSendArguments) => Promise<IMessageSendOutcome>
  /** Reports what became of replies; answers the ids Nessie settled. */
  report: () => ((results: ExecutorIMessageOutboxResult[]) => Promise<string[]>) | undefined
}

const ItemIdSchema = z.object({ id: z.string().uuid() }).passthrough()

const resultOf = (id: string, outcome: IMessageSendOutcome): ExecutorIMessageOutboxResult => {
  if (outcome.ok) return { id, outcome: 'sent', messageGuid: outcome.result.messageGuid, from: outcome.result.from }
  const message = outcome.message.slice(0, 500)
  return outcome.code === 'IMESSAGE_SEND_UNCERTAIN'
    ? { id, outcome: 'unknown', message }
    : { id, outcome: 'refused', code: outcome.code, message }
}

/**
 * Clients replies from the heartbeat answer (docs/imessage.md → "Clients
 * replies"). Each item is checked on its own: one the Mac cannot send is
 * reported as refused and never takes the others down. Each id is sent at most
 * once in this process — Nessie hands each over once — and each outcome is
 * reported alone, every heartbeat, until Nessie answers for it or the attempts
 * run out; a report that fails holds back nothing but itself.
 */
export class IMessageReplies {
  private readonly seen = new Set<string>()
  private unreported: Array<{ result: ExecutorIMessageOutboxResult; attempts: number }> = []
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: IMessageRepliesOptions) {}

  /** One heartbeat answer's `imessageOutbox`, or nothing; either way, outcomes still owed are reported. */
  receive(value: unknown): void {
    const items = Array.isArray(value) ? value.slice(0, EXECUTOR_IMESSAGE_OUTBOX_MAXIMUM) : []
    const fresh: Array<{ id: string; item: z.infer<typeof ExecutorIMessageOutboxItemSchema> | null }> = []
    for (const raw of items) {
      const named = ItemIdSchema.safeParse(raw)
      if (!named.success || this.seen.has(named.data.id)) continue
      this.seen.add(named.data.id)
      const item = ExecutorIMessageOutboxItemSchema.safeParse(raw)
      fresh.push({ id: named.data.id, item: item.success ? item.data : null })
    }
    if (fresh.length === 0 && this.unreported.length === 0) return
    // One after another: a later answer waits for the sends before it.
    this.queue = this.queue.then(async () => {
      for (const entry of fresh) {
        const outcome: IMessageSendOutcome = entry.item
          ? await this.options.send({ to: entry.item.to, text: entry.item.text })
          : { ok: false, code: 'IMESSAGE_SEND_FAILED',
            message: 'This reply is not one the Mac can send: one person\'s address and 1 to 4,000 characters.' }
        this.unreported.push({ result: resultOf(entry.id, outcome), attempts: 0 })
      }
      await this.reportOwed()
    }).catch((error: unknown) => {
      console.error('[nessie-executor] an iMessage reply was not handled:',
        error instanceof Error ? error.message : String(error))
    })
  }

  /** Waits for the replies in hand; tests and shutdown use it. */
  idle(): Promise<void> {
    return this.queue
  }

  private async reportOwed(): Promise<void> {
    const report = this.options.report()
    if (!report) return
    const owed: typeof this.unreported = []
    for (const entry of this.unreported) {
      try {
        // An answer that does not settle it means Nessie has nothing to settle: done either way.
        await report([entry.result])
        continue
      } catch (error) {
        entry.attempts += 1
        if (entry.attempts < IMESSAGE_REPORT_ATTEMPTS) {
          owed.push(entry)
        } else {
          console.error('[nessie-executor] stopped reporting an iMessage reply:', entry.result.id,
            error instanceof Error ? error.message : String(error))
        }
      }
    }
    this.unreported = owed
  }
}
