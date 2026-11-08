import {
  EXECUTOR_COMMAND_CONCURRENCY_VERSION,
  ExecutorDaemonConcurrentCommandPollResponseSchema,
  ExecutorDaemonLegacyCommandPollResponseSchema,
} from '@nessie/executor-protocol'

import { executorApi, ExecutorApiError, type ExecutorApiClient } from './api-client.js'
import type { CommandDispatcher } from './command-dispatcher.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'

/**
 * The daemon's signed command poll (`docs/sessions-and-concurrency.md`).
 *
 * It asks in the concurrent shape — `concurrency: 1`, the free capacity,
 * every held command, which of them wait, and the sessions the owner stopped
 * — and hands the answer to the dispatcher. A Nessie that does not know the
 * shape refuses its fields with `400 VALIDATION_ERROR`, or answers in the old
 * shape; for the rest of that connection the daemon then asks one command at
 * a time, as it always did, and a reconnect tries the concurrent shape again.
 */

const CONCURRENT_FIELDS = /\b(?:concurrency|capacity|activeCommands|waiting|stoppedSessions)\b/u

/** Nessie's strict parsing refused a field only a concurrent poll sends. */
export const concurrentPollRefused = (error: unknown): boolean => error instanceof ExecutorApiError
  && error.status === 400 && error.code === 'VALIDATION_ERROR'
  && CONCURRENT_FIELDS.test(`${error.message} ${JSON.stringify(error.details ?? null)}`)

type PollState = Pick<ExecutorLocalState, 'apiBaseUrl' | 'connectionEpoch' | 'executorId' | 'machinePrivateKey'>

export const createDaemonCommandPoll = (input: {
  state: () => PollState
  dispatcher: Pick<CommandDispatcher, 'accept' | 'activeCommands' | 'cancel' | 'capacity' | 'closeSessions'
    | 'held' | 'setMode' | 'stoppedSessions' | 'waiting'>
  api?: Pick<ExecutorApiClient, 'pollCommand'>
  log?: (message: string) => void
  now?: () => Date
}) => {
  const api = input.api ?? executorApi
  const log = input.log ?? ((message: string) => { console.error(`[nessie-executor] ${message}`) })
  const now = input.now ?? (() => new Date())
  const { dispatcher } = input
  // The connection epoch on which Nessie answered in the old shape.
  let singleOn: string | undefined

  const oneAtATime = (epoch: string, why: string): void => {
    if (singleOn !== epoch) log(`${why} This Nessie hands out one command at a time, so this computer runs one at a time.`)
    singleOn = epoch
    dispatcher.setMode('single')
  }

  const pollOne = async (state: PollState & { connectionEpoch: string }): Promise<void> => {
    // The command held now watches its own cancellation (`watchLegacyCancellation`).
    if (dispatcher.held() > 0) return
    const payload = { connectionEpoch: state.connectionEpoch, executorId: state.executorId, observedAt: now().toISOString() }
    const response = await api.pollCommand(state.apiBaseUrl, {
      ...payload, signature: signExecutorDaemonPayload(state.machinePrivateKey, 'poll', payload),
    })
    const answer = ExecutorDaemonLegacyCommandPollResponseSchema.parse(response)
    if (answer.command) await dispatcher.accept([answer.command])
  }

  return {
    /** Whether the current connection hands out one command at a time. */
    single: (): boolean => {
      const epoch = input.state().connectionEpoch
      return epoch !== undefined && singleOn === epoch
    },
    poll: async (): Promise<void> => {
      const state = input.state()
      const epoch = state.connectionEpoch
      if (!epoch) return
      const live = { ...state, connectionEpoch: epoch }
      if (singleOn === epoch) return pollOne(live)
      dispatcher.setMode('concurrent')
      const waiting = dispatcher.waiting()
      const stoppedSessions = dispatcher.stoppedSessions()
      // Each optional field joins the signed payload exactly when it is present.
      const payload = {
        activeCommands: dispatcher.activeCommands(),
        capacity: dispatcher.capacity(),
        concurrency: EXECUTOR_COMMAND_CONCURRENCY_VERSION,
        connectionEpoch: epoch,
        executorId: state.executorId,
        observedAt: now().toISOString(),
        ...(stoppedSessions.length ? { stoppedSessions } : {}),
        ...(waiting.length ? { waiting } : {}),
      }
      let response: unknown
      try {
        response = await api.pollCommand(state.apiBaseUrl, {
          ...payload, signature: signExecutorDaemonPayload(state.machinePrivateKey, 'poll', payload),
        })
      } catch (error) {
        if (!concurrentPollRefused(error)) throw error
        oneAtATime(epoch, 'Nessie refused the concurrent command poll.')
        return pollOne(live)
      }
      if (response && typeof response === 'object' && 'commands' in response) {
        const answer = ExecutorDaemonConcurrentCommandPollResponseSchema.parse(response)
        // Cancellations and closes first: they may name a command this answer also re-delivers.
        dispatcher.cancel(answer.cancellations)
        dispatcher.closeSessions(answer.sessionClose)
        await dispatcher.accept(answer.commands)
        return
      }
      const answer = ExecutorDaemonLegacyCommandPollResponseSchema.parse(response)
      oneAtATime(epoch, 'Nessie answered the command poll in the one-command shape.')
      if (answer.command) await dispatcher.accept([answer.command])
    },
  }
}

export type DaemonCommandPoll = ReturnType<typeof createDaemonCommandPoll>
