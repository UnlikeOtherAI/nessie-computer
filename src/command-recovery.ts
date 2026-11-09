import type { ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import { ExecutorApiError } from './api-client.js'
import type { ExecutorCommandJournal, ExecutorCommandRecord } from './command-journal.js'

export const EXECUTOR_COMMAND_UNKNOWN_OUTCOME_RESULT = Object.freeze({
  code: 'EXECUTOR_COMMAND_UNKNOWN_OUTCOME',
  success: false,
})
// What a result the control plane refused becomes. It is small and well formed
// by construction, so the replacement receipt cannot be refused the same way.
export const EXECUTOR_RESULT_REFUSED_RESULT = Object.freeze({
  code: 'EXECUTOR_RESULT_REFUSED',
  success: false,
})

type ReceiptState = 'accepted' | 'started' | 'result_acknowledged'

export type ExecutorCommandReceiptSender = (input: {
  commandId: ExecutorCommandEnvelope['commandId']
  result?: Record<string, unknown>
  state: ReceiptState
}) => Promise<void>

/**
 * A result's images, which live beside the journal as sidecars
 * (`command-attachments.ts`). They are uploaded before the result's receipt —
 * `deliver` answers the result to send, with any image Nessie refused
 * withdrawn and each one it answered for journaled through `journal` — and
 * released once the receipt is acknowledged.
 */
export type ExecutorCommandRecoveryAttachments = {
  deliver: (input: {
    command: ExecutorCommandEnvelope
    delivered: readonly string[]
    journal: (progress: { delivered: string[]; result: Record<string, unknown> }) => Promise<void>
    result: Record<string, unknown>
  }) => Promise<Record<string, unknown>>
  release: (commandId: ExecutorCommandEnvelope['commandId']) => Promise<void>
}

/**
 * What the dispatcher gives a command when it may start: either a slot and its
 * resources (`release` gives them back), or the result it ends with without
 * running — cancelled, stopped or closed while it waited.
 */
export type ExecutorCommandAdmission =
  | { release: () => void; result?: undefined }
  | { release?: undefined; result: Record<string, unknown> }

export type ExecutorCommandLifecycle = {
  journal: Pick<ExecutorCommandJournal, 'remove' | 'save'>
  receipt: ExecutorCommandReceiptSender
  attachments?: ExecutorCommandRecoveryAttachments
  /** Told when the control plane refused a result and it was replaced. */
  onResultRefused?: (command: ExecutorCommandEnvelope) => void
  /** Told each time the record moves to a new phase, after it is journaled. */
  onPhase?: (record: ExecutorCommandRecord) => void
  /** Waits until the command may start. */
  admit: (record: ExecutorCommandRecord) => Promise<ExecutorCommandAdmission>
  execute: (record: ExecutorCommandRecord) => Promise<Record<string, unknown>>
  now?: () => Date
}

const receiptWasFencedByUnknownOutcome = (error: unknown): boolean => (
  error instanceof ExecutorApiError && error.code === 'EXECUTOR_COMMAND_REPLAY'
)

const resultWasRefused = (error: unknown): boolean => (
  error instanceof ExecutorApiError && error.code === 'EXECUTOR_COMMAND_RESULT_INVALID'
)

const isRefusedReplacement = (result: Record<string, unknown> | undefined): boolean => (
  result?.code === EXECUTOR_RESULT_REFUSED_RESULT.code && Object.keys(result).length === 2
)

/**
 * Advances one command to a durable terminal receipt. A response may disappear
 * after the server commits any receipt; retrying that same transition is safe,
 * so a failed step throws with the record still journaled at the phase it
 * reached, and the caller advances it again later. A process death after
 * execution begins is deliberately not retried: the replacement daemon
 * reports an unknown outcome so a side effect cannot run twice.
 */
export const advanceExecutorCommand = async (
  initial: ExecutorCommandRecord, lifecycle: ExecutorCommandLifecycle,
): Promise<void> => {
  const now = lifecycle.now ?? (() => new Date())
  let record = initial
  // Read through a call: `move` replaces `record`, which narrowing cannot see.
  const phase = (): ExecutorCommandRecord['phase'] => record.phase
  let executionStartedHere = false
  let admission: ExecutorCommandAdmission | undefined
  const move = async (next: ExecutorCommandRecord): Promise<void> => {
    await lifecycle.journal.save(next)
    record = next
    lifecycle.onPhase?.(record)
  }
  const unknownOutcome = (): ExecutorCommandRecord => ({
    command: record.command, phase: 'result_pending', receivedAt: record.receivedAt,
    result: { ...EXECUTOR_COMMAND_UNKNOWN_OUTCOME_RESULT },
    ...(record.startedAt ? { startedAt: record.startedAt } : {}), version: 2,
  })
  const send = async (state: 'accepted' | 'started', next: ExecutorCommandRecord): Promise<void> => {
    try {
      await lifecycle.receipt({ commandId: record.command.commandId, state })
    } catch (error) {
      if (!receiptWasFencedByUnknownOutcome(error)) throw error
      await move(unknownOutcome())
      return
    }
    await move(next)
  }

  try {
    if (phase() === 'accepted_pending') await send('accepted', { ...record, phase: 'waiting' })

    if (phase() === 'waiting' || phase() === 'started_pending') {
      admission = await lifecycle.admit(record)
      if (phase() === 'waiting') {
        await move({ ...record, phase: 'started_pending', startedAt: now().toISOString() })
      }
      await send('started', { ...record, phase: 'executing' })
      executionStartedHere = phase() === 'executing'
    }

    if (phase() === 'executing') {
      const result = !executionStartedHere ? { ...EXECUTOR_COMMAND_UNKNOWN_OUTCOME_RESULT }
        : admission?.result ?? await lifecycle.execute(record)
      admission?.release?.()
      admission = undefined
      await move({ ...record, phase: 'result_pending', result })
    }
  } finally {
    admission?.release?.()
  }

  if (phase() !== 'result_pending' || !record.result) return
  // The images a result references reach Nessie before the receipt does,
  // from sidecars written before this entry was journaled. A restart here
  // uploads again whatever Nessie had not yet answered for; the control
  // plane takes a repeat as the same upload.
  if (lifecycle.attachments) {
    let pending = record
    const result = await lifecycle.attachments.deliver({
      command: pending.command,
      delivered: pending.delivered ?? [],
      journal: async (progress) => {
        pending = { ...pending, ...progress }
        await lifecycle.journal.save(pending)
      },
      result: record.result,
    })
    record = { ...pending, result }
  }
  try {
    await lifecycle.receipt({ commandId: record.command.commandId, result: record.result, state: 'result_acknowledged' })
  } catch (error) {
    // A refused result is refused again on every retry: retrying it would
    // hold that command's record for good. The replacement is journaled before
    // it is sent, so a lost response replays it rather than the refused
    // result; the receipt's digest is computed from it afresh.
    if (!resultWasRefused(error) || isRefusedReplacement(record.result)) throw error
    lifecycle.onResultRefused?.(record.command)
    await move({ ...record, result: { ...EXECUTOR_RESULT_REFUSED_RESULT } })
    await lifecycle.receipt({ commandId: record.command.commandId, result: record.result, state: 'result_acknowledged' })
  }
  await lifecycle.journal.remove(record.command.commandId)
  // After the journal lets go, never before: a crash between the two leaves
  // a folder no journal names, which the daemon's next start removes, where
  // the other order would leave a journal naming images that are gone.
  await lifecycle.attachments?.release(record.command.commandId).catch(() => undefined)
}
