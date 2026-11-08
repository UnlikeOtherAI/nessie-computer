import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { SessionControl, Threads } from '@nessie/t3-session-source/engine'
import { ExecutorT3Request, requestTargets } from '@nessie/executor-protocol/t3-session'

export type SessionControlRequest = Extract<ExecutorT3Request, { readonly method:
  'orchestration.dispatchCommand' | 'orchestration.launchThread'
  | 'orchestration.stopWorkflow' | 'orchestration.forceStopThread' }>

/** Structural validation is not admission. The gateway and runtime must resolve
 * every target against fresh authority before evaluating any returned effect.
 */
export class SessionControlInputError extends Error {
  constructor() { super('T3_CONTROL_INPUT_REFUSED'); this.name = 'SessionControlInputError' }
}

export const validateControlRequest = (request: SessionControlRequest): void => {
  if (!Schema.is(ExecutorT3Request)(request)) throw new SessionControlInputError()
  switch (request.method) {
    case 'orchestration.dispatchCommand': case 'orchestration.launchThread':
    case 'orchestration.stopWorkflow': case 'orchestration.forceStopThread': break
    default: throw new SessionControlInputError()
  }
  try { requestTargets(request) } catch { throw new SessionControlInputError() }
}

/** Runs in the existing writer graph; never creates a runtime or another queue.
 * Provenance is stamped by the admitted caller, separately from the request body.
 * An interrupted wait does not prove that this mutation was not accepted.
 */
export const executeSessionControl = (
  request: SessionControlRequest, provenance: Threads.ThreadManagementProvenance,
) => Effect.gen(function* () {
  yield* Effect.try({ try: () => validateControlRequest(request), catch: () => new SessionControlInputError() })
  switch (request.method) {
    case 'orchestration.dispatchCommand': return yield* SessionControl.dispatchCommand(request.input, provenance)
    case 'orchestration.launchThread': return yield* SessionControl.launchThread(request.input, provenance)
    case 'orchestration.stopWorkflow': {
      const threads = yield* Threads.ThreadManagementService
      return yield* threads.stopWorkflow(request.input)
    }
    case 'orchestration.forceStopThread': {
      const threads = yield* Threads.ThreadManagementService
      return yield* threads.forceStopThread(request.input)
    }
    default: return yield* Effect.fail(new SessionControlInputError())
  }
})
