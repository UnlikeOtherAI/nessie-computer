import {
  ExecutorDaemonIMessageResponseSchema,
  type ExecutorDaemonIMessageResponse,
  type ExecutorIMessageIncoming,
} from '@nessie/executor-protocol'

import { executorApi, type ExecutorApiClient } from '../api-client.js'
import { signExecutorDaemonPayload } from '../daemon-signature.js'
import type { ExecutorLocalState } from '../state-store.js'

/**
 * Hands Nessie a batch of received messages under this connection, signed by
 * the machine key over `nessie.executor.daemon.imessage.v1` (the body without
 * its signature). Nessie admits it exactly as it admits a command poll.
 */
export const deliverIMessages = async (
  state: ExecutorLocalState,
  messages: ExecutorIMessageIncoming[],
  api: Pick<ExecutorApiClient, 'deliverIMessages'> = executorApi,
): Promise<ExecutorDaemonIMessageResponse> => {
  if (!state.connectionEpoch) throw new Error('This team is not connected from this computer right now.')
  const payload = {
    connectionEpoch: state.connectionEpoch,
    executorId: state.executorId,
    messages,
    observedAt: new Date().toISOString(),
  }
  const signature = signExecutorDaemonPayload(state.machinePrivateKey, 'imessage', payload)
  return ExecutorDaemonIMessageResponseSchema.parse(
    await api.deliverIMessages(state.apiBaseUrl, { ...payload, signature }),
  )
}
