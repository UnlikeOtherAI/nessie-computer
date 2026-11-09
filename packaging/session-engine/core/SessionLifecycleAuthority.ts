import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'

export type SessionLifecycleAction = 'legacy-shell-reconcile' | 'runtime-recover' | 'delegated-task-recover'
  | 'prepare-shutdown' | 'runtime-reconcile-shutdown'

export class SessionLifecycleActionRefused extends Error {
  constructor() { super('T3_SESSION_LIFECYCLE_ACTION_REFUSED'); this.name = 'SessionLifecycleActionRefused' }
}

/** Required current owner for these concrete original SQL/event mutations.
 * Graph retention, reserve and a row-preclaim grant do not provide this service.
 * There is no default, native producer or blanket imported-row recovery grant. */
export class SessionLifecycleAuthority extends Context.Service<SessionLifecycleAuthority, {
  readonly withAction: <A, E, R>(action: SessionLifecycleAction, original: Effect.Effect<A, E, R>) =>
    Effect.Effect<A, E | SessionLifecycleActionRefused, R>
}>()('nessie/t3-session/SessionLifecycleAuthority') {}

/** Keep the actual original result and join its finite work. An owner cannot
 * skip a required operation, replace a failure, call it twice or retain a live
 * mutation callback after its admission attempt has returned. */
export const withSessionLifecycleAction = <A, E, R>(authority: SessionLifecycleAuthority['Service'],
  action: SessionLifecycleAction, original: Effect.Effect<A, E, R>):
  Effect.Effect<A, E | SessionLifecycleActionRefused, Exclude<R, Scope.Scope>> => Effect.scoped(
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    let live = true, called = false
    let result: { readonly value: A } | undefined
    const guarded = Effect.suspend<A, E | SessionLifecycleActionRefused, R>(() => {
      if (!live || called) return Effect.fail(new SessionLifecycleActionRefused())
      called = true
      // Even an owner that detaches its wait cannot detach the original SQL
      // operation: its child is retained in this finite action's Scope.
      return original.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join),
        Effect.tap(value => Effect.sync(() => { result = { value } })))
    })
    return yield* authority.withAction(action, guarded).pipe(Effect.flatMap(value =>
      result !== undefined && Object.is(value, result.value)
        ? Effect.succeed(value) : Effect.fail(new SessionLifecycleActionRefused())),
    Effect.ensuring(Effect.sync(() => { live = false })))
  }),
)
