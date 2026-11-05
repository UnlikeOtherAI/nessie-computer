import {
  EXECUTOR_COMMAND_CANCELLED_RESULT,
  ExecutorCommandCancellationSchema,
  ExecutorCommandCancellationTargetSchema,
  canonicalExecutorJson,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { executorApi, ExecutorApiError, type ExecutorApiClient } from './api-client.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'

/** Watch beside execution: the ordinary command poll is occupied until the receipt is durable. */
export const executeWithCommandCancellation = async (input: {
  api?: Pick<ExecutorApiClient, 'pollCommand'>
  cancel: () => Promise<void>
  command: ExecutorCommandEnvelope
  execute: (signal: AbortSignal) => Promise<Record<string, unknown>>
  intervalMs?: number
  state: Pick<ExecutorLocalState, 'apiBaseUrl' | 'connectionEpoch' | 'executorId' | 'machinePrivateKey'>
}): Promise<Record<string, unknown>> => {
  const { command, state } = input
  if (!state.connectionEpoch) throw new Error('Executor has not claimed a live daemon connection.')
  const activeCommand = ExecutorCommandCancellationTargetSchema.strip().parse(command)
  const api = input.api ?? executorApi
  const controller = new AbortController()
  let finished = false
  let checking = false
  let teardown: Promise<void> | undefined
  let work: Promise<Record<string, unknown>> | undefined
  const cancel = (): void => {
    teardown ??= Promise.resolve().then(input.cancel)
    controller.abort()
    void teardown.catch(() => undefined)
  }
  const check = async (): Promise<void> => {
    if (finished || checking || controller.signal.aborted) return
    checking = true
    try {
      const payload = {
        activeCommand,
        connectionEpoch: state.connectionEpoch!,
        executorId: state.executorId,
        observedAt: new Date().toISOString(),
      }
      const response = await api.pollCommand(state.apiBaseUrl, {
        ...payload,
        signature: signExecutorDaemonPayload(state.machinePrivateKey, 'cancel', payload),
      })
      if (finished || !response.cancellation) return
      const cancellation = ExecutorCommandCancellationSchema.parse(response.cancellation)
      const target = ExecutorCommandCancellationTargetSchema.strip().parse(cancellation)
      if (canonicalExecutorJson(target) !== canonicalExecutorJson(activeCommand)) {
        throw new Error('Executor cancellation does not name the active command.')
      }
      // Set the verdict before signalling a backend that rejects synchronously.
      cancel()
    } catch (error) {
      // Reconnect or revocation fenced this epoch. The old execution cannot
      // keep working while its receipt waits to replay under the new epoch.
      if (!finished && error instanceof ExecutorApiError && error.code === 'EXECUTOR_CONNECTION_FENCED') cancel()
      // A transient request failure is retried on the next non-overlapping tick.
      // It never invents a cancellation or abandons the command's own TTL.
      if (!finished) console.error('[nessie-executor] cancellation poll failed:', error instanceof Error ? error.message : String(error))
    } finally {
      checking = false
    }
  }
  await check()
  const timer = setInterval(() => { void check() }, input.intervalMs ?? 1_000)
  let interrupted: (() => void) | undefined
  try {
    const cancelled = new Promise<Record<string, unknown>>((resolve) => {
      interrupted = () => resolve(EXECUTOR_COMMAND_CANCELLED_RESULT)
      if (controller.signal.aborted) interrupted()
      else controller.signal.addEventListener('abort', interrupted, { once: true })
    })
    work = controller.signal.aborted ? undefined : input.execute(controller.signal)
    const result = controller.signal.aborted
      ? EXECUTOR_COMMAND_CANCELLED_RESULT
      : await Promise.race([work!, cancelled])
    if (controller.signal.aborted) {
      await teardown
      // Backends finish their signal-driven process teardown before the
      // cancelled receipt is journaled. Their late output is discarded.
      await work?.catch((error: unknown) => {
        if (error === controller.signal.reason || error instanceof Error && error.name === 'AbortError') return
        throw error
      })
      return EXECUTOR_COMMAND_CANCELLED_RESULT
    }
    return result
  } finally {
    finished = true
    clearInterval(timer)
    if (interrupted) controller.signal.removeEventListener('abort', interrupted)
  }
}
