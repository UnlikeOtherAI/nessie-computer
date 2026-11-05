import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { createHash } from 'node:crypto'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'
import type { PersonalNativeWriters } from './personal-native-writers.js'

export type PersonalNativeStateChild = {
  pid?: number
  stdin: Writable
  stdout: Readable
  kill: () => boolean
  once: (event: 'error' | 'close', listener: (...args: unknown[]) => void) => unknown
}
export type PersonalNativeStateRunnerOptions = {
  timeoutMs?: number
  stopWaitMs?: number
  spawn?: (helper: string, args: string[]) => PersonalNativeStateChild
}

/** Complete stdin frame is sent only after the shared child claim has been published. */
const frame = (body: Uint8Array): Buffer => Buffer.concat([
  Buffer.from(`${JSON.stringify({ version: 1, length: body.length,
    digest: createHash('sha256').update(body).digest('hex') })}\n`), Buffer.from(body),
])

/** A stopped pipe/timeout is not process-exit proof. Unknown writers remain in the shared journal. */
export const runPersonalNativeState = async (
  helper: string, args: string[], bytes?: Uint8Array, writers?: PersonalNativeWriters,
  options: PersonalNativeStateRunnerOptions = {},
): Promise<Record<string, unknown>> => {
  if (!writers && (args.length !== 1 || args[0] !== 'personal-state-context')) {
    throw new PersonalInferenceProtectionError('personal_state_writer_required')
  }
  const run = (track?: Parameters<Parameters<PersonalNativeWriters['execute']>[0]>[0]) =>
    new Promise<Record<string, unknown>>((settle, reject) => {
      const child = (options.spawn ?? ((file, argv) =>
        spawn(file, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })))(helper, args)
      let output = Buffer.alloc(0)
      let settled = false
      let cancelling = false
      let cancellationCode = 'personal_state_mutation_unknown'
      let release: (() => Promise<void>) | undefined
      let killWait: NodeJS.Timeout | undefined
      const finish = (error?: string, answer?: Record<string, unknown>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killWait) clearTimeout(killWait)
        if (error) reject(new PersonalInferenceProtectionError(error))
        else settle(answer ?? {})
      }
      const cancel = (code: string): void => {
        if (settled || cancelling) return
        cancelling = true
        cancellationCode = code
        try { child.kill() } catch { /* No stop proof; retain the shared claim. */ }
        // The journal remains when no actual close is observed, including
        // kill() returning false. A later adapter reconciles the kernel identity.
        killWait = setTimeout(() => finish('personal_state_writer_unknown'), options.stopWaitMs ?? 3_000)
      }
      const timer = setTimeout(() => cancel('personal_state_mutation_unknown'), options.timeoutMs ?? 15_000)
      child.once('error', () => cancel('personal_state_native_unavailable'))
      child.stdin.on('error', () => cancel('personal_state_mutation_unknown'))
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled || cancelling) return
        output = Buffer.concat([output, chunk])
        if (output.length > 8192) cancel('personal_state_mutation_unknown')
      })
      let tracking: Promise<void>
      child.once('close', (code) => {
        void (async () => {
          try { await tracking; await release?.() }
          catch { finish('personal_state_writer_unknown'); return }
          if (settled) return
          if (cancelling) { finish(cancellationCode); return }
          let answer: Record<string, unknown>
          try { answer = JSON.parse(output.toString('utf8')) as Record<string, unknown> }
          catch { finish('personal_state_mutation_unknown'); return }
          if (!answer || typeof answer !== 'object' || code !== 0
            || !['secured', 'verified'].includes(String(answer.status))) {
            finish(answer?.code === 'EXECUTOR_PERSONAL_STATE_CONFLICT'
              ? 'personal_state_conflict' : 'personal_state_native_rejected')
            return
          }
          finish(undefined, answer)
        })()
      })
      tracking = (async () => {
        try {
          if (track) release = await track(child)
          if (!settled && !cancelling) child.stdin.end(track ? frame(bytes ?? new Uint8Array()) : bytes)
          else child.stdin.destroy()
        } catch { cancel('personal_state_writer_unknown'); child.stdin.destroy() }
      })()
    })
  return writers ? writers.execute((track) => run(track)) : run()
}
