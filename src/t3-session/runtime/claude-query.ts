import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import type * as Scope from 'effect/Scope'
import { OriginalClaudeQuery, OriginalClaudeRunner } from '@nessie/t3-session-source/engine'
import { createSessionClaudeQuery, type SessionClaudeOwner, type SessionClaudePrompt }
  from '@nessie/t3-session-source/claude-sdk'
import { joinedNativeEffect } from './native-effect.js'

type Input = Parameters<OriginalClaudeRunner.ClaudeAgentSdkQueryRunnerShape['open']>[0]
type Session = OriginalClaudeRunner.ClaudeAgentSdkQuerySession
const refused = (method: string) => new OriginalClaudeRunner.ClaudeAgentSdkQueryRunnerError({
  method, cause: new Error('T3_CLAUDE_ORIGINAL_HOST_REFUSED'),
})

/** Original T3 queue, diagnostics, MCP initialization and query controls over the
 * actual SDK capsule. The required owner must supply admitted native creation
 * and exact original-context FRAME writes. No stock launcher or history fallback. */
export const openProtectedOriginalClaudeQuery = (input: Input, owner: SessionClaudeOwner,
  parent: AbortSignal): Effect.Effect<Session, OriginalClaudeRunner.ClaudeAgentSdkQueryRunnerError, Scope.Scope> =>
  Effect.uninterruptibleMask(restore => Effect.gen(function* () {
    // SDK callbacks run before their reply is serialized. A denied response
    // cannot undo their host effects, so they need concrete admitted owners
    // before this path can accept them. Stdio/SDK MCP hosts are separate too.
    if (input.options.canUseTool !== undefined || input.options.hooks !== undefined
      || input.options.onElicitation !== undefined || input.options.onUserDialog !== undefined
      || Object.values(input.options.mcpServers ?? {}).some(server => server.type !== 'http' && server.type !== 'sse')) {
      return yield* Effect.fail(refused('hostCallbacks'))
    }
    const stop = new AbortController(), signal = AbortSignal.any([parent, stop.signal])
    const { promptQueue, prompt } = yield* OriginalClaudeQuery.makeClaudePromptQueue<SessionClaudePrompt>()
    const diagnostics = OriginalClaudeQuery.makeClaudeQueryDiagnostics()
    const { mcpServers, ...sdkOptions } = input.options
    const handle = yield* Effect.try({
      try: () => createSessionClaudeQuery({ ...sdkOptions, stderr: text => {
        OriginalClaudeQuery.appendClaudeQueryStderr(diagnostics, text)
        sdkOptions.stderr?.(text)
      } }, owner, signal),
      catch: () => refused('query'),
    })
    diagnostics.stderrClosed = handle.stderrDrained
    let closing: Promise<void> | undefined
    const close = () => closing ??= (async () => {
      stop.abort()
      try { await Effect.runPromise(Queue.shutdown(promptQueue)) }
      finally { await handle.close() }
    })()
    yield* Effect.addFinalizer(() => Effect.promise(close))
    // This is the actual original Queue.take iterator. Interrupting its queue
    // releases the take; capsule close joins that exact SDK pump and cleanup.
    const pumping = yield* Effect.try({ try: () => handle.streamInput({ messages: prompt,
      interrupt: () => Effect.runPromise(Queue.shutdown(promptQueue).pipe(Effect.asVoid)) }),
    catch: () => refused('query') })
    void pumping.catch(() => { stop.abort() })
    const awaitNative = (work: Promise<void>, method: string) => joinedNativeEffect(async cancellation => {
      const cancel = () => stop.abort()
      cancellation.addEventListener('abort', cancel, { once: true })
      try {
        if (cancellation.aborted) cancel()
        await work
        signal.throwIfAborted()
      } finally { cancellation.removeEventListener('abort', cancel) }
    }, () => refused(method))
    const closeEffect = Effect.tryPromise({ try: close, catch: () => refused('close') })
    yield* restore(awaitNative(handle.ready, 'query').pipe(
      Effect.andThen(OriginalClaudeQuery.initializeClaudeQuery(handle.query, input, mcpServers)),
    )).pipe(Effect.onError(() => closeEffect.pipe(Effect.orDie)))
    return {
      messages: OriginalClaudeQuery.makeClaudeQueryMessages(handle.query, diagnostics),
      ...OriginalClaudeQuery.makeClaudeQueryControls(handle.query),
      offer: (message, onQueued) => Effect.uninterruptibleMask(offerRestore => Effect.gen(function* () {
        // Capture actual SDK bytes and the owner's original operation context
        // synchronously BEFORE the original Queue.offer can yield.
        const token = yield* Effect.try({ try: () => handle.capturePrompt(message),
          catch: () => refused('offer') })
        yield* offerRestore(Queue.offer(promptQueue, token))
        yield* offerRestore(awaitNative(token.acknowledged, 'offer'))
        yield* Effect.sync(() => onQueued?.())
      })).pipe(Effect.onError(() => closeEffect.pipe(Effect.orDie))),
      close: closeEffect,
    } satisfies Session
  }))
