import { ExecutorSessionViewOffersSchema, type ExecutorSessionViewRequest,
  type ExecutorSessionInventoryPage, type ExecutorSessionActionReceipt } from '@nessie/executor-protocol'

import { executorApi } from './api-client.js'
import type { CodingSessionsDaemon } from './coding-sessions-daemon.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'

type RelayState = Pick<ExecutorLocalState, 'apiBaseUrl' | 'executorId' | 'machinePrivateKey' | 'connectionEpoch'> & {
  descriptor: Pick<ExecutorLocalState['descriptor'], 'codingSessions'>
}

/** The caller owns serialization and cancellation, just like its command poll. */
export const createSessionViewRelay = (bridge: Pick<CodingSessionsDaemon, 'screen' | 'inventory' | 'conversation' | 'action'>) => {
  let requests: ExecutorSessionViewRequest[] = []
  let lastReport = 0
  let cursor: string | undefined
  let pendingInventory: ExecutorSessionInventoryPage | undefined
  let epoch: string | undefined
  let receipts: ExecutorSessionActionReceipt[] = []
  return async (state: RelayState): Promise<void> => {
    if (!state.connectionEpoch || !state.descriptor.codingSessions) return
    if (epoch !== state.connectionEpoch) {
      epoch = state.connectionEpoch
      cursor = undefined
      pendingInventory = undefined
      requests = []
      lastReport = 0
    }
    const frames = await Promise.all(requests.map(async (request) => ({
      ...request, screen: await bridge.screen(request).catch(() => null),
      ...(bridge.conversation ? { conversation: await bridge.conversation(request).catch(() => null) } : {}),
    })))
    if (!pendingInventory && (cursor || Date.now() - lastReport > 15_000)) {
      pendingInventory = await bridge.inventory(cursor)
    }
    const payload = {
      executorId: state.executorId, connectionEpoch: state.connectionEpoch,
      observedAt: new Date().toISOString(), frames,
      ...(receipts.length ? { receipts } : {}),
      ...(pendingInventory ? { sessions: pendingInventory.sessions, inventory: pendingInventory.inventory } : {}),
    }
    // Clear demand on failure; a reconnected daemon obtains fresh offers before uploading.
    requests = []
    const signature = signExecutorDaemonPayload(state.machinePrivateKey, 'session_view', payload)
    const response = await executorApi.exchangeSessionViews(state.apiBaseUrl, { ...payload, signature })
    const offers = ExecutorSessionViewOffersSchema.parse(response)
    requests = offers.requests
    receipts = []
    for (const action of offers.actions ?? []) {
      if (!bridge.action) continue
      receipts.push(await bridge.action(action).catch(() => ({
        id: action.id, state: 'outcome_unknown' as const, code: 'delivery_unknown',
      })))
    }
    if (pendingInventory) {
      cursor = pendingInventory.nextCursor ?? undefined
      if (!cursor) lastReport = Date.now()
      pendingInventory = undefined
    }
  }
}
