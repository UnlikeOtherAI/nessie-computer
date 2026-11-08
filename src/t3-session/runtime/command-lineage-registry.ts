import * as Effect from 'effect/Effect'
import { CommandLineage } from '@nessie/t3-session-source/engine'
import type { T3ExecutionBinding } from '@nessie/executor-protocol/t3-session'
import { makeSessionLaunchCommandLineage, type SessionLaunchCommandLineage } from './command-lineage.js'

export interface SessionCommandLineageRegistry {
  readonly service: CommandLineage.SessionCommandLineage['Service']
  register(binding: Pick<T3ExecutionBinding, 'commandId' | 'threadId'>, recheck: () => Promise<void>,
    parent: AbortSignal): SessionLaunchCommandLineage
  close(): void
}

/** The original launch layer is memoized across commands in the same source
 * graph. Route by its actual parent command, never a current/latest operation.
 * Retired command IDs stay burned for this owner; a new recorder cannot renew
 * a cancelled reservation. No entry in this registry authorizes an effect. */
export function makeSessionCommandLineageRegistry(signal: AbortSignal): SessionCommandLineageRegistry {
  const entries = new Map<string, SessionLaunchCommandLineage | undefined>()
  let live = true
  const refused = () => new CommandLineage.SessionCommandLineageError()
  const close = () => {
    live = false
    for (const owner of entries.values()) owner?.close()
    entries.clear()
    signal.removeEventListener('abort', close)
  }
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) close()
  return Object.freeze<SessionCommandLineageRegistry>({
    service: CommandLineage.SessionCommandLineage.of({ recordInitialMessage: edge => Effect.suspend(() => {
      const owner = live && !signal.aborted ? entries.get(edge.parentCommandId) : undefined
      return owner ? owner.service.recordInitialMessage(edge) : Effect.fail(refused())
    }) }),
    register: (binding, recheck, parent) => {
      const commandId = binding.commandId
      // The fixed source control channel also bounds all call IDs to 4096.
      if (!live || signal.aborted || parent.aborted || !commandId || !binding.threadId
        || entries.has(commandId) || entries.size >= 4096) throw refused()
      const owner = makeSessionLaunchCommandLineage(binding, recheck, AbortSignal.any([signal, parent]))
      const registered = Object.freeze<SessionLaunchCommandLineage>({ ...owner, close: () => {
        owner.close()
        if (live) entries.set(commandId, undefined)
      } })
      entries.set(commandId, registered)
      return registered
    },
    close,
  })
}
