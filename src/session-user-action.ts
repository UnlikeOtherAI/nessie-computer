import { ExecutorSessionActionSchema, type ExecutorSessionActionReceipt } from '@nessie/executor-protocol'
import { argumentsFor, CodingBridgeError } from './coding-session/bridge-tools.js'
import type { CodingBridge } from './coding-session/managed-bridge.js'
import { assertPersonalHostExecution } from './personal-host-execution.js'
import { deliverOnce } from './existing-session/delivery.js'

/** The server admitted the human; the bridge still enforces the local provider and custody rules. */
export const sessionUserAction = async (
  value: unknown, stateDir: string, managed: CodingBridge,
  nativeSend: (kind: string, id: string, message: string, owner: string, command: string)
    => Promise<Record<string, unknown>>,
): Promise<ExecutorSessionActionReceipt> => {
  const action = ExecutorSessionActionSchema.parse(argumentsFor(value,
    ['id', 'kind', 'message', 'ownerKey', 'sessionId', 'expiresAt']))
  const receipt = (state: ExecutorSessionActionReceipt['state'], code: string): ExecutorSessionActionReceipt =>
    ({ id: action.id, state, code })
  if (Date.parse(action.expiresAt) <= Date.now()) return receipt('failed', 'input_expired')
  try {
    let result: Record<string, unknown>
    if (action.kind === 'queue' || action.kind === 'push') {
      result = await nativeSend(action.kind, action.sessionId, action.message ?? '', action.ownerKey, action.id)
    } else {
      if (action.kind !== 'interrupt') await assertPersonalHostExecution()
      result = await deliverOnce({ stateDir, commandId: `viewer-${action.id}`, ownerKey: action.ownerKey,
        sessionId: action.sessionId, action: action.kind, message: action.message ?? '', send: async () => {
          const value = await managed.call(action.kind === 'interrupt' ? 'session_interrupt' : 'session_send', {
            sessionId: action.sessionId, ...(action.message ? { message: action.message } : {}),
          }, { daemonControl: true, ownerKey: action.ownerKey, commandId: action.id })
          return { ...value, state: 'accepted', code: action.kind === 'interrupt' ? 'interrupt_requested' : 'input_queued' }
        } })
    }
    if (result.state === 'outcome_unknown') return receipt('outcome_unknown', 'delivery_unknown')
    if (result.state === 'failed' || result.state === 'cancelled') return receipt('failed', 'input_refused')
    return receipt('accepted', typeof result.code === 'string' ? result.code
      : result.state === 'queued_natively' ? 'queued_natively' : 'channel_event_accepted')
  } catch (error) {
    // Do not export provider stderr, paths or credentials in a failure receipt.
    return error instanceof CodingBridgeError && /^[a-z0-9_]{1,100}$/u.test(error.code)
      ? receipt('failed', error.code) : receipt('outcome_unknown', 'delivery_unknown')
  }
}
