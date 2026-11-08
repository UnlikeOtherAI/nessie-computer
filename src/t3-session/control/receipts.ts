import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { CommandReceipts, Threads } from '@nessie/t3-session-source/engine'
import type { CommandId, ThreadId } from '@nessie/t3-session-source/contracts'

export type SessionCommandObservation =
  | { readonly state: 'accepted' | 'rejected'; readonly receipt: CommandReceipts.CommandReceiptV2 }
  | { readonly state: 'uncertain'; readonly reason: 'receipt_not_observed' | 'receipt_unavailable' }

export class SessionReceiptScopeError extends Error {
  constructor() { super('T3_CONTROL_RECEIPT_SCOPE_MISMATCH'); this.name = 'SessionReceiptScopeError' }
}

/** A missing/read-failed receipt never authorizes a new command ID. Retrying the
 * original operation with its original ID is the engine's reconciliation path.
 * Caller admission must include the exact thread; command IDs grant no access.
 */
export const observeSessionCommand = (input: {
  readonly commandId: CommandId; readonly threadId: ThreadId; readonly commandType: string
}): Effect.Effect<SessionCommandObservation, SessionReceiptScopeError, CommandReceipts.CommandReceiptStoreV2> =>
  Effect.gen(function* () {
    const receipts = yield* CommandReceipts.CommandReceiptStoreV2
    const result = yield* receipts.getByCommandId(input.commandId).pipe(
      Effect.map(value => ({ ok: true as const, value })),
      Effect.catch(() => Effect.succeed({ ok: false as const })),
    )
    if (!result.ok) return { state: 'uncertain' as const, reason: 'receipt_unavailable' as const }
    if (Option.isNone(result.value)) return { state: 'uncertain' as const, reason: 'receipt_not_observed' as const }
    const receipt = result.value.value
    if (receipt.threadId !== input.threadId || receipt.commandType !== input.commandType) {
      return yield* Effect.fail(new SessionReceiptScopeError())
    }
    return { state: receipt.status, receipt }
  })

/** Original finite wait, including pending delegated/background completions.
 * timedOut and resultRun are retained. Cancelling this wait never stops work.
 */
export const waitForSessionWork = (input: Threads.ThreadManagementWaitInput) => Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService
  return yield* threads.waitForThread(input)
})
