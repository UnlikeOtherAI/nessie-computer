import * as Effect from 'effect/Effect'

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
