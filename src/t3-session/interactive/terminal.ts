import type { TerminalAttachStreamEvent } from '@nessie/t3-session-source/contracts'
import { TerminalOutputProtocol } from '@nessie/t3-session-source/engine'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
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
): Stream.Stream<TerminalAttachStreamEvent, E> {
  const captured = snapshotInteractiveScope(scope)
  // Resume is mandatory: upstream's no-resync variant ends normally after overflow.
  // The owning native manager must produce a fresh original snapshot before live events.
  const validate = (source: Subscribe<E>): Subscribe<E> => (listener, cleanup) =>
    source(event => Effect.sync(() => constrainTerminalEvent(captured, terminalId, event))
      .pipe(Effect.flatMap(listener)), cleanup)
  return TerminalOutputProtocol.terminalOutputStream(validate(subscribe), validate(resume))
}
