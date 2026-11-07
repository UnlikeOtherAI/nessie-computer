import { ExecutorSessionViewOffersSchema, type ExecutorSessionViewRequest,
  type ExecutorSessionInventoryPage, type ExecutorSessionActionReceipt } from '@nessie/executor-protocol'

import { executorApi } from './api-client.js'
import type { CodingSessionsDaemon } from './coding-sessions-daemon.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'

type RelayState = Pick<ExecutorLocalState, 'apiBaseUrl' | 'executorId' | 'machinePrivateKey' | 'connectionEpoch'> & {
  descriptor: Pick<ExecutorLocalState['descriptor'], 'codingSessions'>
}

export type SessionViewRelay = ((state: RelayState) => Promise<void>) & {
  /** The last answer named view requests or actions: someone is watching, or their input is on its way. */
  hot: () => boolean
  /** The next exchange carries a fresh inventory from its first page, whatever the 15 s pace says. */
  forceInventory: () => void
}

/**
 * The caller owns serialization and cancellation, just like its command poll.
 *
 * Metadata goes out as inventory pages, at most every 15 s, or at once when a
 * session changed on this computer (`forceInventory`): a turn started or
 * ended, a request opened or settled, a session exited. A changed session is
 * the newest, so it leads the first page, with its `pending` summary, whether
 * or not anybody is viewing it.
 */
export const createSessionViewRelay = (
  bridge: Pick<CodingSessionsDaemon, 'screen' | 'inventory' | 'conversation' | 'action'>,
): SessionViewRelay => {
  let requests: ExecutorSessionViewRequest[] = []
  let hot = false
  let forced = false
  let lastReport = 0
  let cursor: string | undefined
  let pendingInventory: ExecutorSessionInventoryPage | undefined
  let epoch: string | undefined
  let receipts: ExecutorSessionActionReceipt[] = []
  const exchange = async (state: RelayState): Promise<void> => {
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
    if (forced && !pendingInventory) {
      forced = false
      cursor = undefined
      pendingInventory = await bridge.inventory()
    } else if (!pendingInventory && (cursor || Date.now() - lastReport > 15_000)) {
      pendingInventory = await bridge.inventory(cursor)
    }
    const payload = {
      executorId: state.executorId, connectionEpoch: state.connectionEpoch,
      observedAt: new Date().toISOString(), frames, conversationVersion: 1 as const,
      ...(receipts.length ? { receipts } : {}),
      ...(pendingInventory ? { sessions: pendingInventory.sessions, inventory: pendingInventory.inventory } : {}),
    }
    // Clear demand on failure; a reconnected daemon obtains fresh offers before uploading.
    requests = []
    const signature = signExecutorDaemonPayload(state.machinePrivateKey, 'session_view', payload)
    const response = await executorApi.exchangeSessionViews(state.apiBaseUrl, { ...payload, signature })
    const offers = ExecutorSessionViewOffersSchema.parse(response)
    requests = offers.requests
    hot = offers.requests.length > 0 || (offers.actions?.length ?? 0) > 0
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
  return Object.assign(exchange, { hot: () => hot, forceInventory: () => { forced = true } })
}
