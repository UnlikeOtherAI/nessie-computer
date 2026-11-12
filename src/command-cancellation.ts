import {
  EXECUTOR_COMMAND_CANCELLED_RESULT,
  ExecutorCommandCancellationSchema,
  ExecutorCommandCancellationTargetSchema,
  canonicalExecutorJson,
  type ExecutorCommandCancellation,
  type ExecutorCommandCancellationTarget,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { executorApi, ExecutorApiError, type ExecutorApiClient } from './api-client.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'

/** The exact delivered fences a cancellation must name; no arguments leave the machine again. */
export const cancellationTargetOf = (command: ExecutorCommandEnvelope): ExecutorCommandCancellationTarget =>
  ExecutorCommandCancellationTargetSchema.strip().parse(command)

/** Whether a cancellation names exactly this command, field for field. */
export const cancellationNames = (
  cancellation: ExecutorCommandCancellation, command: ExecutorCommandEnvelope,
): boolean => canonicalExecutorJson(ExecutorCommandCancellationTargetSchema.strip().parse(cancellation))
  === canonicalExecutorJson(cancellationTargetOf(command))

/**
 * Runs one command's work so that aborting `controller` ends it: `cancel`
 * tears down the backend the command owns, the backend's signal-driven
 * teardown finishes before the answer, and its late output is discarded. The
 * answer is then `cancelled()` — Nessie's cancellation, or why the owner or
 * Nessie ended the command's session.
 */
export const runCancellable = async (input: {
  controller: AbortController
  cancel: () => Promise<void>
  execute: (signal: AbortSignal) => Promise<Record<string, unknown>>
  cancelled?: () => Record<string, unknown>
}): Promise<Record<string, unknown>> => {
  const { controller } = input
  const cancelled = (): Record<string, unknown> => input.cancelled?.() ?? EXECUTOR_COMMAND_CANCELLED_RESULT
  let teardown: Promise<void> | undefined
  const tearDown = (): void => {
    teardown ??= Promise.resolve().then(input.cancel)
    void teardown.catch(() => undefined)
  }
  if (controller.signal.aborted) return cancelled()
  let interrupted: (() => void) | undefined
  try {
    const stopped = new Promise<'cancelled'>((resolve) => {
      interrupted = () => {
        tearDown()
        resolve('cancelled')
      }
      controller.signal.addEventListener('abort', interrupted, { once: true })
    })
    const work = input.execute(controller.signal)
    const result = await Promise.race([work, stopped])
    if (!controller.signal.aborted) return result as Record<string, unknown>
    tearDown()
    await teardown
    await work.catch((error: unknown) => {
      if (error === controller.signal.reason || error instanceof Error && error.name === 'AbortError') return
      throw error
    })
    return cancelled()
  } finally {
    if (interrupted) controller.signal.removeEventListener('abort', interrupted)
  }
}

type CancellationState = Pick<ExecutorLocalState, 'apiBaseUrl' | 'connectionEpoch' | 'executorId' | 'machinePrivateKey'>

/**
 * The one-command-at-a-time shape's cancellation: a signed `cancel`-domain
 * poll beside execution naming the active command, every `intervalMs`. A
 * concurrent daemon learns cancellations from its ordinary poll instead.
 * Answers a function that stops watching.
 */
export const watchLegacyCancellation = (input: {
  api?: Pick<ExecutorApiClient, 'pollCommand'>
  command: ExecutorCommandEnvelope
  intervalMs?: number
  onCancel: () => void
  state: () => CancellationState
}): { stop: () => void; first: Promise<void> } => {
  const activeCommand = cancellationTargetOf(input.command)
  const api = input.api ?? executorApi
  let finished = false
  let checking = false
  const check = async (): Promise<void> => {
    if (finished || checking) return
    checking = true
    const state = input.state()
    try {
      if (!state.connectionEpoch) throw new Error('This team is not connected from this computer right now.')
      const payload = {
        activeCommand,
        connectionEpoch: state.connectionEpoch,
        executorId: state.executorId,
        observedAt: new Date().toISOString(),
      }
      const response = await api.pollCommand(state.apiBaseUrl, {
        ...payload,
        signature: signExecutorDaemonPayload(state.machinePrivateKey, 'cancel', payload),
      })
      const answer = 'cancellation' in response ? response.cancellation : undefined
      if (finished || !answer) return
      const cancellation = ExecutorCommandCancellationSchema.parse(answer)
      if (!cancellationNames(cancellation, input.command)) {
        throw new Error('The cancellation does not name the active command.')
      }
      input.onCancel()
    } catch (error) {
      // Reconnect or revocation fenced this epoch. The old execution cannot
      // keep working while its receipt waits to replay under the new epoch.
      if (!finished && error instanceof ExecutorApiError && error.code === 'EXECUTOR_CONNECTION_FENCED') input.onCancel()
      // A transient request failure is retried on the next non-overlapping tick.
      // It never invents a cancellation or abandons the command's own TTL.
      if (!finished) console.error('[nessie-executor] cancellation poll failed:', error instanceof Error ? error.message : String(error))
    } finally {
      checking = false
    }
  }
  const first = check()
  const timer = setInterval(() => { void check() }, input.intervalMs ?? 1_000)
  return {
    first,
    stop: () => {
      finished = true
      clearInterval(timer)
    },
  }
}

/** One command with its legacy cancellation watch: the shape a daemon that runs one command at a time uses. */
export const executeWithCommandCancellation = async (input: {
  api?: Pick<ExecutorApiClient, 'pollCommand'>
  cancel: () => Promise<void>
  command: ExecutorCommandEnvelope
  execute: (signal: AbortSignal) => Promise<Record<string, unknown>>
  intervalMs?: number
  state: CancellationState
}): Promise<Record<string, unknown>> => {
  if (!input.state.connectionEpoch) throw new Error('This team is not connected from this computer right now.')
  const controller = new AbortController()
  const watch = watchLegacyCancellation({
    api: input.api, command: input.command, intervalMs: input.intervalMs,
    // Set the verdict before signalling a backend that rejects synchronously.
    onCancel: () => controller.abort(), state: () => input.state,
  })
  try {
    await watch.first
    return await runCancellable({ controller, cancel: input.cancel, execute: input.execute })
  } finally {
    watch.stop()
  }
}
