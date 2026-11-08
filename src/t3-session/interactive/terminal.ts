import type { TerminalAttachStreamEvent } from '@nessie/t3-session-source/contracts'
import { TerminalOutputProtocol } from '@nessie/t3-session-source/engine'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { InteractiveFailure } from './operations.js'
import { constrainTerminalEvent } from './projections.js'
import { snapshotInteractiveScope, type InteractiveScope } from './scope.js'

type Subscribe<E> = Parameters<
  typeof TerminalOutputProtocol.terminalOutputStream<TerminalAttachStreamEvent, E>
>[0]

/** Host-internal adapter over the actual pinned queue/resync implementation.
 * Call only inside an admitted native resource scope. Subscription callbacks
 * supply original events, never evidence of identity, grants or native custody.
 */
export function scopedTerminalOutput<E>(
  scope: InteractiveScope, terminalId: string, subscribe: Subscribe<E>, resume: Subscribe<E>,
): Stream.Stream<TerminalAttachStreamEvent, E | InteractiveFailure> {
  const captured = snapshotInteractiveScope(scope)
  // Resume is mandatory: upstream's no-resync variant ends normally after overflow.
  // The owning native manager must produce a fresh original snapshot before live events.
  return Stream.unwrap(Effect.gen(function* () {
    const failed = yield* Deferred.make<never, InteractiveFailure>()
    let invalid = false
    const validate = (source: Subscribe<E>): Subscribe<E> => (listener, cleanup) =>
      source(event => Effect.suspend(() => {
        if (invalid) return Effect.void
        try {
          constrainTerminalEvent(captured, terminalId, event)
        } catch {
          invalid = true
          // Fail the consuming stream even if this callback runs after acquisition.
          // The callback itself has the original infallible Listener signature.
          return Deferred.fail(failed, new InteractiveFailure('resource_mismatch')).pipe(Effect.asVoid)
        }
        return listener(event)
      }), cleanup)
    return TerminalOutputProtocol.terminalOutputStream(validate(subscribe), validate(resume))
      .pipe(Stream.interruptWhen(Deferred.await(failed)))
  }))
}
