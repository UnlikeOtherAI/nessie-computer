import { randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  ExecutorCommandEnvelopeSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { ExecutorApiError } from './api-client.js'
import { assertOwnerOnlyStatePath, secureOwnerOnlyStateFile } from './state-security.js'
import { ensureExecutorRuntimeDirectory } from './state-store.js'

const JOURNAL_FILE = 'command-recovery.json'
const UNKNOWN_OUTCOME_RESULT = {
  code: 'EXECUTOR_COMMAND_UNKNOWN_OUTCOME',
  success: false,
}
// What a result the control plane refused becomes. It is small and well formed
// by construction, so the replacement receipt cannot be refused the same way.
export const EXECUTOR_RESULT_REFUSED_RESULT = {
  code: 'EXECUTOR_RESULT_REFUSED',
  success: false,
}

type ReceiptState = 'accepted' | 'started' | 'result_acknowledged'

export type ExecutorCommandRecovery = {
  command: ExecutorCommandEnvelope
  /**
   * `result_pending` only: the digests of the result's images Nessie has
   * already answered for, so a delivery that failed part-way resumes after them.
   */
  delivered?: string[]
  phase: 'accepted_pending' | 'started_pending' | 'executing' | 'result_pending'
  result?: Record<string, unknown>
  version: 1
}

export type ExecutorCommandRecoveryStore = {
  clear: () => Promise<void>
  load: () => Promise<ExecutorCommandRecovery | null>
  save: (recovery: ExecutorCommandRecovery) => Promise<void>
}

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

export type ExecutorCommandRecoveryTransport = {
  poll: () => Promise<ExecutorCommandEnvelope | null>
  receipt: (input: {
    commandId: ExecutorCommandEnvelope['commandId']
    result?: Record<string, unknown>
    state: ReceiptState
  }) => Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

const DIGEST = /^sha256:[0-9a-f]{64}$/

const isDigestList = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((digest) => typeof digest === 'string' && DIGEST.test(digest))
)

const parseRecovery = (value: unknown): ExecutorCommandRecovery => {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('Executor command recovery journal is malformed.')
  }
  const command = ExecutorCommandEnvelopeSchema.safeParse(value.command)
  const phase = value.phase
  if (
    !command.success
    || !['accepted_pending', 'started_pending', 'executing', 'result_pending'].includes(String(phase))
    || (phase === 'result_pending' && (!isRecord(value.result) || Object.keys(value.result).length === 0))
    || (phase !== 'result_pending' && (value.result !== undefined || value.delivered !== undefined))
    || (value.delivered !== undefined && !isDigestList(value.delivered))
  ) {
    throw new Error('Executor command recovery journal is malformed.')
  }
  return {
    command: command.data,
    ...(isDigestList(value.delivered) ? { delivered: value.delivered } : {}),
    phase: phase as ExecutorCommandRecovery['phase'],
    ...(phase === 'result_pending' ? { result: value.result as Record<string, unknown> } : {}),
    version: 1,
  }
}

export type ExecutorCommandRecoveryStoreDeps = {
  ensureRuntimeDirectory?: (stateDir: string) => Promise<string>
}

/**
 * The journal is local control state, not a second server queue. It lives under
 * the same owner-only boundary as the machine key and is atomically replaced.
 *
 * One store secures the runtime directory **once**, not once per operation.
 * Securing it creates and re-applies an explicit DACL, which on Windows means
 * spawning the packaged native helper twice; the daemon polls once a second, so
 * deriving the journal path per operation cost two process creations a second
 * for the life of the daemon and burned roughly fifty times the CPU its macOS
 * counterpart did, where the same proof is an `lstat`. It is setup, not a
 * per-operation proof: every `load` and `save` below still proves the journal
 * *file* owner-only before this process reads or replaces its contents, which
 * is the check that stands between the daemon and content someone else wrote.
 */
export const createExecutorCommandRecoveryStore = (
  stateDir: string,
  deps: ExecutorCommandRecoveryStoreDeps = {},
): ExecutorCommandRecoveryStore => {
  const ensureRuntimeDirectory = deps.ensureRuntimeDirectory ?? ensureExecutorRuntimeDirectory
  let secured: Promise<string> | undefined
  const journalPath = async (): Promise<string> => {
    // A rejected promise must never be the cached answer: a directory that
    // could not be secured once has to be attempted again, or one transient
    // failure would disable recovery for as long as the daemon runs.
    secured ??= ensureRuntimeDirectory(stateDir)
    try {
      return resolve(await secured, JOURNAL_FILE)
    } catch (error) {
      secured = undefined
      throw error
    }
  }

  return {
    clear: async () => {
      const path = await journalPath()
      try {
        await assertOwnerOnlyStatePath(path, 'file')
        await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
    load: async () => {
      const path = await journalPath()
      try {
        await assertOwnerOnlyStatePath(path, 'file')
        return parseRecovery(JSON.parse(await readFile(path, 'utf8')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    save: async (recovery) => {
      const path = await journalPath()
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.new`
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        try {
          await handle.writeFile(`${JSON.stringify(recovery)}\n`, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await secureOwnerOnlyStateFile(temporaryPath)
        await rename(temporaryPath, path)
      } finally {
        await unlink(temporaryPath).catch(() => undefined)
      }
    },
  }
}

const terminalUnknownOutcome = (
  recovery: ExecutorCommandRecovery,
): ExecutorCommandRecovery => ({
  command: recovery.command,
  phase: 'result_pending',
  result: UNKNOWN_OUTCOME_RESULT,
  version: 1,
})

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
 * Advance one command to a durable terminal receipt. A response may disappear
 * after the server commits any receipt; retrying that same transition is safe.
 * A process death after execution begins is deliberately not retried: the
 * replacement daemon reports an unknown outcome so a side effect cannot run
 * twice.
 */
export const recoverOrPollExecutorCommand = async (input: {
  attachments?: ExecutorCommandRecoveryAttachments
  execute: (command: ExecutorCommandEnvelope) => Promise<Record<string, unknown>>
  /** Told when the control plane refused a result and it was replaced. */
  onResultRefused?: (command: ExecutorCommandEnvelope) => void
  store: ExecutorCommandRecoveryStore
  transport: ExecutorCommandRecoveryTransport
}): Promise<boolean> => {
  let recovery = await input.store.load()
  let executionStartedHere = false
  if (!recovery) {
    const command = await input.transport.poll()
    if (!command) return false
    recovery = { command, phase: 'accepted_pending', version: 1 }
    await input.store.save(recovery)
  }

  if (recovery.phase === 'accepted_pending') {
    try {
      await input.transport.receipt({ commandId: recovery.command.commandId, state: 'accepted' })
    } catch (error) {
      if (!receiptWasFencedByUnknownOutcome(error)) throw error
      recovery = terminalUnknownOutcome(recovery)
      await input.store.save(recovery)
    }
    if (recovery.phase === 'accepted_pending') {
      recovery = { ...recovery, phase: 'started_pending' }
      await input.store.save(recovery)
    }
  }

  if (recovery.phase === 'started_pending') {
    try {
      await input.transport.receipt({ commandId: recovery.command.commandId, state: 'started' })
    } catch (error) {
      if (!receiptWasFencedByUnknownOutcome(error)) throw error
      recovery = terminalUnknownOutcome(recovery)
      await input.store.save(recovery)
    }
    if (recovery.phase === 'started_pending') {
      recovery = { ...recovery, phase: 'executing' }
      await input.store.save(recovery)
      executionStartedHere = true
    }
  }

  if (recovery.phase === 'executing') {
    const result = executionStartedHere
      ? await input.execute(recovery.command)
      : UNKNOWN_OUTCOME_RESULT
    recovery = { command: recovery.command, phase: 'result_pending', result, version: 1 }
    await input.store.save(recovery)
  }

  if (recovery.phase === 'result_pending') {
    // The images a result references reach Nessie before the receipt does,
    // from sidecars written before this entry was journaled. A restart here
    // uploads again whatever Nessie had not yet answered for; the control
    // plane takes a repeat as the same upload.
    const pendingResult = recovery.result
    if (input.attachments && pendingResult) {
      let pending = recovery
      const result = await input.attachments.deliver({
        command: pending.command,
        delivered: pending.delivered ?? [],
        journal: async (progress) => {
          pending = { ...pending, ...progress }
          await input.store.save(pending)
        },
        result: pendingResult,
      })
      recovery = { ...pending, result }
    }
    try {
      await input.transport.receipt({
        commandId: recovery.command.commandId,
        result: recovery.result,
        state: 'result_acknowledged',
      })
    } catch (error) {
      // A refused result is refused again on every retry, and the journal
      // holds this machine's only command lane: retrying it would wedge the
      // executor behind one bad answer for good. The replacement is journaled
      // before it is sent, so a lost response replays it rather than the
      // refused result; the receipt's digest is computed from it afresh.
      if (!resultWasRefused(error) || isRefusedReplacement(recovery.result)) throw error
      input.onResultRefused?.(recovery.command)
      recovery = { ...recovery, result: { ...EXECUTOR_RESULT_REFUSED_RESULT } }
      await input.store.save(recovery)
      await input.transport.receipt({
        commandId: recovery.command.commandId,
        result: recovery.result,
        state: 'result_acknowledged',
      })
    }
    await input.store.clear()
    // After the journal lets go, never before: a crash between the two leaves
    // a folder no journal names, which the daemon's next start removes, where
    // the other order would leave a journal naming images that are gone.
    await input.attachments?.release(recovery.command.commandId).catch(() => undefined)
  }
  return true
}
