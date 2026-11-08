import { ExecutorT3Descriptors } from '@nessie/executor-protocol/t3-session'
import type { ExecutorT3Method, ExecutorT3Descriptor } from '@nessie/executor-protocol/t3-session'

export interface SessionControlToolOperation<M extends ExecutorT3Method> {
  readonly method: M
  readonly descriptor: ExecutorT3Descriptor<M>
  readonly delivery: 'finite' | 'stream'
  readonly retry: 'original-command' | 'transport-reconciliation' | 'resubscribe'
  readonly authority: 'operate' | 'owner'
  readonly binding: 'required'
}

/** Shared operation inventory for UI, WebMCP and internal/external MCP owners.
 * These descriptors are not registrations or authority. Tools pass the original
 * input to the admitted gateway; they must never call an executor writer directly.
 */
const operation = <M extends ExecutorT3Method>(method: M, delivery: 'finite' | 'stream',
  retry: 'original-command' | 'transport-reconciliation' | 'resubscribe',
  authority: 'operate' | 'owner' = 'operate'): SessionControlToolOperation<M> => ({
  method, descriptor: ExecutorT3Descriptors[method], delivery, retry,
  authority,
  binding: 'required' as const,
})

export const sessionControlToolOperations = {
  dispatch: operation('orchestration.dispatchCommand', 'finite', 'original-command'),
  launch: operation('orchestration.launchThread', 'finite', 'original-command'),
  stopWorkflow: operation('orchestration.stopWorkflow', 'finite', 'transport-reconciliation'),
  forceStop: operation('orchestration.forceStopThread', 'finite', 'transport-reconciliation'),
  scheduleUpsert: operation('scheduledTasks.upsert', 'finite', 'transport-reconciliation', 'owner'),
  scheduleSetEnabled: operation('scheduledTasks.setEnabled', 'finite', 'transport-reconciliation', 'owner'),
  scheduleDelete: operation('scheduledTasks.delete', 'finite', 'transport-reconciliation', 'owner'),
  scheduleRunNow: operation('scheduledTasks.runNow', 'finite', 'transport-reconciliation', 'owner'),
  schedules: operation('scheduledTasks.subscribe', 'stream', 'resubscribe', 'owner'),
} as const
