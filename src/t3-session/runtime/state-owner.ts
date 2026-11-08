import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { SessionStateError } from './paths.js'

/** A live writer incarnation, not source identity, native custody or effect authority. */
export class SessionStateOwner extends Context.Service<SessionStateOwner, {
  readonly runtimeGeneration: string
  readonly assertCurrent: Effect.Effect<void, SessionStateError>
}>()('nessie/t3-session/SessionStateOwner') {}
