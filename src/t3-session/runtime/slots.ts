import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { SessionEngineLifecycle, type Threads } from '@nessie/t3-session-source/engine'
import { ExecutorT3Descriptors as D, ExecutorT3Request,
  type ExecutorT3ImplementationSlots } from '@nessie/executor-protocol/t3-session'
import { executeSessionControl, type SessionControlRequest } from '../../coding-session/t3-control.js'
import { retainedCatalogSlots, type RetainedCatalogService } from '../catalog/service.js'
import { sessionOperationScope } from './operation-scope.js'

type Requirements<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never
type ControlServices = Requirements<ReturnType<typeof executeSessionControl>>

/** Keep typed source errors; invalid adapter output and transport defects are not source errors. */
const sourceResult = <A, AI, E, EI, R>(operation: Effect.Effect<unknown, unknown, R>,
  success: Schema.Codec<A, AI>, failure: Schema.Codec<E, EI>): Effect.Effect<A, E, R> => operation.pipe(
  Effect.catch(cause => Schema.decodeUnknownEffect(failure)(cause).pipe(
    Effect.catch(() => Effect.die(cause)), Effect.flatMap(Effect.fail))),
  Effect.flatMap(value => Schema.decodeUnknownEffect(success)(value).pipe(Effect.orDie)),
)

/**
 * One request's slots, created only INSIDE the signed broker's admitted writer
 * graph. This is not a transport or an admission producer. Routing/provenance
 * come from that broker, never from the payload. Do not retain this map for a
 * different request. The original complete envelope reaches the control owner.
 */
export const bindSessionControlSlots = (
  request: SessionControlRequest, provenance: Threads.ThreadManagementProvenance,
) => Effect.gen(function* () {
  const lifecycle = yield* SessionEngineLifecycle
  const bind = yield* sessionOperationScope<ControlServices>()
  const originalInput = request.input
  const encoded = Schema.encodeSync(ExecutorT3Request)
  const admittedBytes = JSON.stringify(encoded(request))
  const snapshot = Schema.decodeUnknownSync(ExecutorT3Request)(JSON.parse(admittedBytes))
  if (!isSessionControlRequest(snapshot)) return yield* Effect.die(new Error('T3_RUNTIME_SLOT_REQUEST_MISMATCH'))
  const execute = (input: unknown) => Effect.gen(function* () {
    // A slot map must not turn one admitted envelope into arbitrary later input.
    // Slots receive the decoded original request.input from the signed lane.
    if (input !== originalInput || JSON.stringify(encoded(request)) !== admittedBytes) {
      return yield* Effect.die(new Error('T3_RUNTIME_SLOT_REQUEST_MISMATCH'))
    }
    yield* lifecycle.assertRunning.pipe(Effect.orDie)
    return yield* executeSessionControl(snapshot, provenance)
  })
  switch (request.method) {
    case 'orchestration.dispatchCommand': return {
      'orchestration.dispatchCommand': input => bind(sourceResult(execute(input),
        D['orchestration.dispatchCommand'].successSchema, D['orchestration.dispatchCommand'].errorSchema)),
    } satisfies ExecutorT3ImplementationSlots
    case 'orchestration.launchThread': return {
      'orchestration.launchThread': input => bind(sourceResult(execute(input),
        D['orchestration.launchThread'].successSchema, D['orchestration.launchThread'].errorSchema)),
    } satisfies ExecutorT3ImplementationSlots
    case 'orchestration.stopWorkflow': return {
      'orchestration.stopWorkflow': input => bind(sourceResult(execute(input),
        D['orchestration.stopWorkflow'].successSchema, D['orchestration.stopWorkflow'].errorSchema)),
    } satisfies ExecutorT3ImplementationSlots
    case 'orchestration.forceStopThread': return {
      'orchestration.forceStopThread': input => bind(sourceResult(execute(input),
        D['orchestration.forceStopThread'].successSchema, D['orchestration.forceStopThread'].errorSchema)),
    } satisfies ExecutorT3ImplementationSlots
  }
})

/** Passive finite reads use their source-owner fenced service, with no provider startup. */
export const bindRetainedCatalogSlots = (service: RetainedCatalogService) => Effect.gen(function* () {
  const slots = retainedCatalogSlots(service)
  const bind = yield* sessionOperationScope<never>()
  return {
    'orchestration.getArchivedShellSnapshot': input => bind(slots['orchestration.getArchivedShellSnapshot'](input)),
    'orchestration.getThreadFamily': input => bind(slots['orchestration.getThreadFamily'](input)),
    'orchestration.getOlderSettledThreads': input => bind(slots['orchestration.getOlderSettledThreads'](input)),
    'orchestration.getThreadTitles': input => bind(slots['orchestration.getThreadTitles'](input)),
    'orchestration.getWorktreeThreadIds': input => bind(slots['orchestration.getWorktreeThreadIds'](input)),
    'orchestration.getThreadProjection': input => bind(slots['orchestration.getThreadProjection'](input)),
    'orchestration.getTurnItem': input => bind(slots['orchestration.getTurnItem'](input)),
    'orchestration.searchThread': input => bind(slots['orchestration.searchThread'](input)),
  } satisfies ExecutorT3ImplementationSlots
})

export const isSessionControlRequest = (request: ExecutorT3Request): request is SessionControlRequest =>
  request.method === 'orchestration.dispatchCommand' || request.method === 'orchestration.launchThread'
  || request.method === 'orchestration.stopWorkflow' || request.method === 'orchestration.forceStopThread'
