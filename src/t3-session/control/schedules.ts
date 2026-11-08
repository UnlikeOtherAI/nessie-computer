import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { ScheduledTasks } from '@nessie/t3-session-source/engine'
import type * as S from '@nessie/t3-session-source/contracts'
import { ExecutorT3Request, requestTargets } from '@nessie/executor-protocol/t3-session'
import { SessionControlInputError } from './operations.js'

export type ScheduleMutationRequest = Extract<ExecutorT3Request, { readonly method:
  'scheduledTasks.upsert' | 'scheduledTasks.setEnabled' | 'scheduledTasks.delete' | 'scheduledTasks.runNow' }>

export type ScheduleMutationResult = S.ScheduledTaskMutationResult | S.ScheduledTaskDeleteResult
  | (S.ScheduledTaskRunNowResult & { readonly threadId: S.ThreadId | null })

/** Required source service only. The original scheduler is deliberately not
 * composed: its secrets and each occurrence need canonical admitted owners.
 * Transport receipts must reconcile these non-command-ID source mutations;
 * especially runNow must never be retried after an ambiguous delivery.
 */
export const executeSessionSchedule = (request: ScheduleMutationRequest): Effect.Effect<ScheduleMutationResult,
  S.ScheduledTaskError | SessionControlInputError, ScheduledTasks.ScheduledTaskService> => Effect.gen(function* () {
  yield* Effect.try({ try: () => {
    if (!Schema.is(ExecutorT3Request)(request)) throw new SessionControlInputError()
    requestTargets(request)
  }, catch: () => new SessionControlInputError() })
  const schedules = yield* ScheduledTasks.ScheduledTaskService
  switch (request.method) {
    case 'scheduledTasks.upsert': return yield* schedules.upsert(request.input)
    case 'scheduledTasks.setEnabled': return yield* schedules.setEnabled(request.input)
    case 'scheduledTasks.delete': return yield* schedules.delete(request.input)
    case 'scheduledTasks.runNow': return yield* schedules.runNow(request.input)
    default: return yield* Effect.fail(new SessionControlInputError())
  }
})

/** Transport owns bounded demand and filters every stored schedule target before
 * publication. Cancelling a subscription does not pause or delete its schedules.
 */
export const subscribeSessionSchedules = (): Stream.Stream<S.ScheduledTaskListResult,
  S.ScheduledTaskError, ScheduledTasks.ScheduledTaskService> => Stream.unwrap(Effect.gen(function* () {
  const schedules = yield* ScheduledTasks.ScheduledTaskService
  return schedules.subscribeList()
}))
