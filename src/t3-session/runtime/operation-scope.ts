import * as Effect from 'effect/Effect'
import * as Cause from 'effect/Cause'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'

export class SessionOperationScopeClosed extends Error {
  constructor() { super('T3_RUNTIME_OPERATION_SCOPE_CLOSED'); this.name = 'SessionOperationScopeClosed' }
}

/** Preserve the caller's cancellation identity without hiding failed finalizers. */
export const runSessionEffect = async <A, E>(operation: Effect.Effect<A, E>, signal: AbortSignal): Promise<A> => {
  const exit = await Effect.runPromiseExit(operation, { signal })
  if (Exit.isSuccess(exit)) return exit.value
  if (signal.aborted && Cause.hasInterruptsOnly(exit.cause)) throw signal.reason
  return Effect.runPromise(Effect.failCause(exit.cause))
}

/**
 * Capture an already-built graph, not a Layer factory or admission callback.
 * The broker owns signed admission. Only its admitted unresolved operation is
 * evaluated here. A scoped child shares the captured services and is joined;
 * cancelling demand interrupts that child without stopping the runtime.
 */
export const sessionOperationScope = <R>() => Effect.gen(function* () {
  const context = yield* Effect.context<R>()
  const operations = yield* Scope.make('parallel')
  let open = true
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    open = false
    // Wait for operation finalizers before providers, SQLite and the writer close.
    yield* Scope.close(operations, Exit.void)
  }))
  return <A, E>(operation: Effect.Effect<A, E, R | Scope.Scope>): Effect.Effect<A, E> => Effect.uninterruptibleMask(restore =>
    Effect.gen(function* () {
      if (!open) return yield* Effect.die(new SessionOperationScopeClosed())
      // Scope attachment fences closure races. Mask only the attach/join handoff
      // so cancellation cannot strand a child between fork and its join cleanup.
      const child = yield* restore(Effect.scoped(operation).pipe(Effect.provide(context)))
        .pipe(Effect.forkIn(operations))
      return yield* restore(Fiber.join(child)).pipe(Effect.onInterrupt(() => Fiber.interrupt(child)))
    }))
})
