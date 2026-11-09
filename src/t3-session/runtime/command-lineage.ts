import * as Effect from 'effect/Effect'
import { CommandLineage, type Outbox } from '@nessie/t3-session-source/engine'
import type { T3ExecutionBinding } from '@nessie/executor-protocol/t3-session'
import type { SessionOriginalCommandSink } from '../source/execution-command.js'

type Edge = CommandLineage.InitialMessageCommandEdge
type RunEdge = CommandLineage.InitialMessageRunEdge
type Release = CommandLineage.PreparedRunReleaseCommandEdge
export type SessionProviderTurnStartEffect = Pick<Outbox.OrchestrationEffectV2, 'commandId' | 'threadId' | 'request'>
export interface SessionLaunchCommandLineage {
  readonly service: CommandLineage.SessionCommandLineage['Service']
  assertInitialMessage(threadId: string): Effect.Effect<void, CommandLineage.SessionCommandLineageError>
  /** Metadata match only. The caller still needs real admission BEFORE claiming the row. */
  assertProviderTurnStart(effect: SessionProviderTurnStartEffect):
    Effect.Effect<void, CommandLineage.SessionCommandLineageError>
  close(): void
}

/** Constructed after the actual native reservation and receipt checks. This
 * records original creation/acceptance relationships, never effect authority.
 * No child ID is derived from an identifier's spelling. */
export function makeSessionLaunchCommandLineage(binding: Pick<T3ExecutionBinding, 'commandId' | 'threadId'>,
  recheck: () => Promise<void>, signal: AbortSignal,
  observe?: SessionOriginalCommandSink): SessionLaunchCommandLineage {
  const parentCommandId = binding.commandId, threadId = binding.threadId
  let live = true
  let initial: Readonly<Edge> | undefined
  let acceptedRun: Readonly<RunEdge> | undefined
  let release: Readonly<Release> | undefined
  let released = false
  const refused = () => new CommandLineage.SessionCommandLineageError()
  const close = () => {
    if (!live) return
    live = false; initial = undefined; acceptedRun = undefined; release = undefined; released = false
    signal.removeEventListener('abort', close)
    observe?.retire()
  }
  const current = async () => {
    if (!live || signal.aborted) throw refused()
    await recheck()
    if (!live || signal.aborted) throw refused()
  }
  const checked = (work: () => Promise<void>) => Effect.tryPromise({
    try: async () => { try { await work() } catch { close(); throw refused() } }, catch: refused,
  }).pipe(Effect.onInterrupt(() => Effect.sync(close)))
  const sameInitial = (edge: Edge) => initial && initial.parentCommandId === edge.parentCommandId
    && initial.commandId === edge.commandId && initial.threadId === edge.threadId
    && initial.messageId === edge.messageId
  const copyRelease = (edge: Release): Readonly<Release> => Object.freeze({ parentCommandId: edge.parentCommandId,
    commandId: edge.commandId, threadId: edge.threadId, runId: edge.runId })
  const sameRelease = (edge: Release) => release && release.parentCommandId === edge.parentCommandId
    && release.commandId === edge.commandId && release.threadId === edge.threadId && release.runId === edge.runId
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
      if (initial && !sameInitial(captured)) throw refused()
      await observe?.record({ ...captured, phase: 'initial-created' })
      initial ??= captured
      await current()
    }),
    recordInitialMessageRun: edge => checked(async () => {
      const captured = Object.freeze({ parentCommandId: edge.parentCommandId, commandId: edge.commandId,
        threadId: edge.threadId, messageId: edge.messageId, runId: edge.runId })
      await current()
      if (!sameInitial(captured) || typeof captured.runId !== 'string' || !captured.runId
        || acceptedRun && acceptedRun.runId !== captured.runId) throw refused()
      await observe?.record({ ...captured, phase: 'initial-accepted' })
      acceptedRun ??= captured
      await current()
    }),
    recordPreparedRunRelease: edge => checked(async () => {
      const captured = copyRelease(edge)
      await current()
      if (!acceptedRun || captured.parentCommandId !== parentCommandId || captured.threadId !== threadId
        || captured.runId !== acceptedRun.runId || typeof captured.commandId !== 'string' || !captured.commandId
        || captured.commandId === parentCommandId || captured.commandId === acceptedRun.commandId
        || release && !sameRelease(captured)) throw refused()
      await observe?.record({ ...captured, phase: 'release-created' })
      release ??= captured
      await current()
    }),
    recordPreparedRunReleased: edge => checked(async () => {
      const captured = copyRelease(edge)
      await current()
      if (!sameRelease(captured)) throw refused()
      await observe?.record({ ...captured, phase: 'release-accepted' })
      released = true
      await current()
    }) }),
    assertInitialMessage: selectedThread => checked(async () => {
      await current()
      if (!initial || selectedThread !== threadId) throw refused()
      await current()
    }),
    assertProviderTurnStart: effect => checked(async () => {
      const commandId = effect.commandId, selectedThread = effect.threadId
      const request = Object.freeze({ type: effect.request.type,
        runId: effect.request.type === 'provider-turn.start' ? effect.request.runId : undefined })
      await current()
      if (!acceptedRun || !release || !released || commandId !== release.commandId || selectedThread !== threadId
        || request.type !== 'provider-turn.start' || request.runId !== acceptedRun.runId) throw refused()
      await current()
    }),
    close,
  })
}
