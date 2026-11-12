import type { ExecutorOperatingSystem } from '@nessie/executor-protocol'

import { saveExecutorState, type ExecutorLocalState } from '../state-store.js'

export const IMESSAGE_OPERATION_KEY = 'imessage.send'

/**
 * A Mac's descriptor offers `imessage.send`; no other computer's does. Like
 * the local-apps pair it is managed rather than chosen: offering it grants
 * nothing, because the Mac still refuses every send until its owner switched
 * iMessage on in Nessie and macOS granted the permissions (docs/imessage.md).
 */
export const withHostIMessageOperation = (
  operationKeys: readonly string[], os: ExecutorOperatingSystem,
): string[] => {
  const others = operationKeys.filter((key) => key !== IMESSAGE_OPERATION_KEY)
  return os === 'macos' ? [...others, IMESSAGE_OPERATION_KEY] : others
}

/**
 * Before a claim: a Mac paired before iMessage existed gains the operation
 * under a new revision, saved through the compare-and-set writer, so the
 * claim submits it. Answers the state to claim with.
 */
export const ensureHostIMessageOperation = async (
  stateDir: string, state: ExecutorLocalState, os: ExecutorOperatingSystem,
): Promise<ExecutorLocalState> => {
  const operationKeys = withHostIMessageOperation(state.descriptor.operationKeys, os)
  const unchanged = operationKeys.length === state.descriptor.operationKeys.length
    && operationKeys.every((key) => state.descriptor.operationKeys.includes(key))
  if (unchanged) return state
  const next: ExecutorLocalState = {
    ...state,
    descriptor: { ...state.descriptor, operationKeys, revision: state.descriptor.revision + 1 },
  }
  await saveExecutorState(stateDir, next, state)
  return next
}
