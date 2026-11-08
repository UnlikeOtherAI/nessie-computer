import { randomUUID } from 'node:crypto'

import { formatExecutorCommandPattern, parseExecutorCommandPattern } from '@nessie/executor-protocol'

import type { ProgramRequestAnswer, ProgramRequestStore } from './program-requests.js'

/**
 * Turns "this program is not allowed here" into a question for the computer's
 * owner. A launch that the rules refuse only because the program is not on the
 * allowlist — never one the denylist refuses — is held while a program
 * request waits in the state directory (`program-requests.ts`), at most
 * `MAX_HOLD_MS` and never past the command's own expiry, less the time its
 * result needs to reach Nessie. The owner answers on the computer:
 *
 * - **once**: this launch runs, and nothing is saved.
 * - **always**: `program-request answer` first saves `<program> *` through the
 *   ordinary policy writer, which the running daemon applies live; this launch
 *   runs at once rather than waiting for that.
 * - **deny**: refused with `owner_declined`.
 *
 * No answer in time is `owner_did_not_answer`. While the launch waits, the
 * agent's call stays open, and the team's one command lane is held with it:
 * every other command for this team waits behind it.
 */
export const MAX_HOLD_MS = 120_000
/** What a result needs after the hold ends: its receipts, before the command expires. */
export const RESULT_MARGIN_MS = 5_000
/** A shorter window is too short for a person to read and answer, so nobody is asked. */
export const MIN_HOLD_MS = 5_000

export type ProgramRequestRefusal = 'owner_declined' | 'owner_did_not_answer'

export type ProgramRequestVerdict =
  | { allowed: true; answer: Exclude<ProgramRequestAnswer, 'deny'> }
  | { allowed: false; reason: ProgramRequestRefusal | 'no_time' }

export type ProgramRequestGate = {
  ask: (launch: {
    program: string
    args: string[]
    /** The command's own expiry. */
    expiresAt: string
    signal?: AbortSignal
  }) => Promise<ProgramRequestVerdict>
}

/**
 * The rule `always` saves: `<program> *`, naming a program given by its path
 * by its file name (without `.exe` or `.com` on Windows), which is how the
 * rules compare names. Undefined when the name cannot be written as a rule.
 */
export const programRequestRule = (
  program: string, platform: NodeJS.Platform = process.platform,
): string | undefined => {
  const file = program.split(platform === 'win32' ? /[\\/]/u : /\//u).at(-1) ?? ''
  const name = platform === 'win32' ? file.replace(/\.(?:exe|com)$/iu, '') : file
  const pattern = parseExecutorCommandPattern(`${name} *`)
  return pattern && pattern.program === name ? formatExecutorCommandPattern(pattern) : undefined
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(done, ms)
  function done(): void {
    clearTimeout(timer)
    signal?.removeEventListener('abort', done)
    resolve()
  }
  signal?.addEventListener('abort', done, { once: true })
})

export const createProgramRequestGate = (input: {
  store: Pick<ProgramRequestStore, 'create' | 'answer' | 'remove'>
  now?: () => number
  pollMs?: number
  log?: (message: string) => void
}): ProgramRequestGate => {
  const now = input.now ?? Date.now
  const log = input.log ?? ((message: string) => { console.error(`[nessie-executor] ${message}`) })
  return {
    ask: async ({ program, args, expiresAt, signal }) => {
      const started = now()
      const deadline = Math.min(started + MAX_HOLD_MS, Date.parse(expiresAt) - RESULT_MARGIN_MS)
      if (!(deadline - started >= MIN_HOLD_MS) || programRequestRule(program) === undefined) {
        return { allowed: false, reason: 'no_time' }
      }
      const id = randomUUID()
      await input.store.create({
        id, program, args: [...args],
        requestedAt: new Date(started).toISOString(), expiresAt: new Date(deadline).toISOString(),
      })
      log(`program request ${id} waits for the owner to allow ${program}`)
      try {
        while (now() < deadline && !signal?.aborted) {
          const answer = await input.store.answer(id)
          if (answer === 'deny') return { allowed: false, reason: 'owner_declined' }
          if (answer) return { allowed: true, answer }
          await sleep(Math.min(input.pollMs ?? 250, Math.max(0, deadline - now())), signal)
        }
        return { allowed: false, reason: 'owner_did_not_answer' }
      } finally {
        await input.store.remove(id).catch(() => undefined)
      }
    },
  }
}

/** The refusal an agent reads when the owner said no, or was not asked in time. */
export const programRequestRefusal = (
  program: string, reason: ProgramRequestVerdict & { allowed: false },
): Record<string, unknown> => reason.reason === 'no_time'
  ? { code: 'EXECUTOR_COMMAND_DENIED', success: false }
  : {
    code: 'EXECUTOR_COMMAND_DENIED',
    message: reason.reason === 'owner_declined'
      ? `The computer's owner chose not to allow ${program} to run.`
      : `The computer's owner did not answer the request to run ${program} in time.`,
    reason: reason.reason,
    success: false,
  }
