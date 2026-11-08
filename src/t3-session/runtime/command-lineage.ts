import * as Effect from 'effect/Effect'
import { CommandLineage } from '@nessie/t3-session-source/engine'
import type { T3ExecutionBinding } from '@nessie/executor-protocol/t3-session'

type Edge = CommandLineage.InitialMessageCommandEdge
export interface SessionLaunchCommandLineage {
  readonly service: CommandLineage.SessionCommandLineage['Service']
  assertInitialMessage(threadId: string): Effect.Effect<void, CommandLineage.SessionCommandLineageError>
  close(): void
}

/** Constructed after the actual native reservation and receipt checks. This
 * records original creation, never acceptance, effect authority or run lineage.
 * No child ID is derived from an identifier's spelling. */
export function makeSessionLaunchCommandLineage(binding: Pick<T3ExecutionBinding, 'commandId' | 'threadId'>,
  recheck: () => Promise<void>, signal: AbortSignal): SessionLaunchCommandLineage {
  const parentCommandId = binding.commandId, threadId = binding.threadId
  let live = true
  let initial: Readonly<Edge> | undefined
  const refused = () => new CommandLineage.SessionCommandLineageError()
  const close = () => { live = false; initial = undefined; signal.removeEventListener('abort', close) }
  const current = async () => {
    if (!live || signal.aborted) throw refused()
    await recheck()
    if (!live || signal.aborted) throw refused()
  }
  const checked = (work: () => Promise<void>) => Effect.tryPromise({
    try: async () => { try { await work() } catch { close(); throw refused() } }, catch: refused,
  }).pipe(Effect.onInterrupt(() => Effect.sync(close)))
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) close()
  return Object.freeze<SessionLaunchCommandLineage>({
    service: CommandLineage.SessionCommandLineage.of({ recordInitialMessage: edge => checked(async () => {
      const captured = Object.freeze({ parentCommandId: edge.parentCommandId, commandId: edge.commandId,
        threadId: edge.threadId, messageId: edge.messageId })
      await current()
      if (captured.parentCommandId !== parentCommandId || captured.threadId !== threadId
        || typeof captured.commandId !== 'string' || !captured.commandId || captured.commandId === parentCommandId
        || typeof captured.messageId !== 'string' || !captured.messageId) throw refused()
      if (initial && (initial.parentCommandId !== captured.parentCommandId || initial.commandId !== captured.commandId
        || initial.threadId !== captured.threadId || initial.messageId !== captured.messageId)) throw refused()
      initial ??= captured
      await current()
    }) }),
    assertInitialMessage: selectedThread => checked(async () => {
      await current()
      if (!initial || selectedThread !== threadId) throw refused()
      await current()
    }),
    close,
  })
}
