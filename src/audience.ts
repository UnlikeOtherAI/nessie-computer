import {
  ExecutorDaemonAudienceRequestSchema,
  ExecutorDaemonAudienceResponseSchema,
  type ExecutorDaemonAudienceResponse,
} from '@nessie/executor-protocol'

import { executorApi, type ExecutorApiClient } from './api-client.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import { loadExecutorState, type ExecutorLocalState } from './state-store.js'

/**
 * "Who can send work here" (contract §4.7): the agents, people and projects
 * the paired team lets reach this computer, read from Nessie with the
 * daemon's signed connection (`POST /api/executor-daemon/audience`, signed
 * under `nessie.executor.daemon.audience.v1` over the request without its
 * signature).
 *
 * The answer is a view for the computer's owner. Nothing here stores it: it
 * never grants or narrows access, and a stale copy would only mislead.
 */
export const requestAudience = async (
  state: ExecutorLocalState,
  api: Pick<ExecutorApiClient, 'audience'> = executorApi,
  now: () => Date = () => new Date(),
): Promise<ExecutorDaemonAudienceResponse> => {
  if (!state.connectionEpoch) {
    throw new Error('This team is not connected yet. Start Nessie Computer, then try again.')
  }
  const payload = {
    connectionEpoch: state.connectionEpoch, executorId: state.executorId, observedAt: now().toISOString(),
  }
  const request = ExecutorDaemonAudienceRequestSchema.parse({
    ...payload, signature: signExecutorDaemonPayload(state.machinePrivateKey, 'audience', payload),
  })
  return ExecutorDaemonAudienceResponseSchema.parse(await api.audience(state.apiBaseUrl, request))
}

/** The CLI's `audience --state-dir <dir> --json`: load the team's state and ask. */
export const readAudience = async (
  stateDir: string,
  dependencies: { api?: Pick<ExecutorApiClient, 'audience'>; now?: () => Date } = {},
): Promise<ExecutorDaemonAudienceResponse> => (
  requestAudience(await loadExecutorState(stateDir), dependencies.api, dependencies.now)
)
