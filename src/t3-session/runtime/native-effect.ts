import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

/** Scope enters Closed before its finalizers drain. Check the actual parent
 * chain so escaped factories cannot acquire work during that cleanup window. */
export const isSessionScopeOpen = (scope: Scope.Scope): boolean => {
  for (let current: Scope.Scope | undefined = scope; current; current = current.parent) {
    if (current.state._tag === 'Closed') return false
  }
  return true
}

/** An interrupted Effect must not detach a native companion's Promise while
 * its protected positive-clearance finally block is still running. This joins
 * that exact call; it never retries it or turns a rejected close into success. */
export const joinedNativeEffect = <A, E>(start: (signal: AbortSignal) => Promise<A>, refused: () => E):
  Effect.Effect<A, E> => Effect.uninterruptibleMask(restore => Effect.gen(function* () {
  const stop = new AbortController()
  const pending = yield* Effect.try({ try: () => start(stop.signal), catch: refused })
  // Install rejection handling before entering the interruptible wait.
  void pending.catch(() => undefined)
  return yield* restore(Effect.tryPromise({ try: () => pending, catch: refused })).pipe(
    Effect.onInterrupt(() => Effect.promise(async () => {
      stop.abort()
      try { await pending } catch { throw refused() }
    })),
  )
}))
