import { win32 } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Scope from 'effect/Scope'
import * as SecureRandom from 'effect/crypto/SecureRandom'
import * as Stream from 'effect/Stream'
import { OriginalClaudeRunner, OriginalClaudeProtocol } from '@nessie/t3-session-source/engine'
import type { SessionClaudeOwner } from '@nessie/t3-session-source/claude-sdk'
import type { HeldNativeSessionProvider, ReservedSessionLaunch } from './native-launch.js'
import { openProtectedOriginalClaudeQuery } from './claude-query.js'
import type { CapturedProviderFrame } from './provider-serialization.js'
import { isSessionScopeOpen, joinedNativeEffect } from './native-effect.js'

type Runner = OriginalClaudeRunner.ClaudeAgentSdkQueryRunnerShape
type Input = Parameters<Runner['open']>[0]
type ClaudeProvider = Extract<HeldNativeSessionProvider, { readonly driver: 'claude' }>
export type SessionClaudeHistoryOwner = Pick<Runner, 'forkSession' | 'subagentLaunchToolUseId' | 'assertComplete'>
const refused = (method: string) => new OriginalClaudeRunner.ClaudeAgentSdkQueryRunnerError({
  method, cause: new Error('T3_CLAUDE_ORIGINAL_HOST_REFUSED'),
})

/** The original runner tag and allocator over one original reserved operation.
 * History requires its own real admitted owner; no SDK host-config fallback.
 * The shared original turn-start edge requests association; native consumes
 * only its independently retained stdout observation, never an argument ID. */
export const makeSessionClaudeQueryRunner = (launch: ReservedSessionLaunch, history: SessionClaudeHistoryOwner):
  Effect.Effect<Runner, never, Scope.Scope | SecureRandom.SecureRandom> => Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom
  const scope = yield* Scope.Scope
  let live = true, opened = false
  yield* Effect.addFinalizer(() => Effect.sync(() => { live = false }))
  const current = (threadId?: string) => live && isSessionScopeOpen(scope)
    && !launch.signal.aborted && launch.target.driver === 'claude'
    && (threadId === undefined || threadId === launch.target.threadId)
  const open: Runner['open'] = (input: Input) => Effect.gen(function* () {
    if (!current(input.threadId) || opened || !input.options.env?.CLAUDE_CONFIG_DIR
      || !input.options.pathToClaudeCodeExecutable || !input.options.cwd
      || !win32.isAbsolute(input.options.pathToClaudeCodeExecutable)
      || win32.extname(input.options.pathToClaudeCodeExecutable).toLowerCase() !== '.exe'
      || input.options.spawnClaudeCodeProcess || input.options.sessionStore) return yield* Effect.fail(refused('query'))
    opened = true // Failed or ambiguous native preparation cannot reopen this factory.
    yield* launch.commandLineage.assertInitialMessage(input.threadId).pipe(Effect.mapError(() => refused('query')))
    const lifetime = new AbortController(), signal = AbortSignal.any([launch.signal, lifetime.signal])
    let resolveReady!: (provider: ClaudeProvider) => void, rejectReady!: (error: unknown) => void
    let release!: () => void
    const ready = { promise: new Promise<ClaudeProvider>((resolve, reject) => {
      resolveReady = resolve; rejectReady = reject
    }), resolve: (provider: ClaudeProvider) => resolveReady(provider), reject: (error: unknown) => rejectReady(error) }
    const released = { promise: new Promise<void>(resolve => { release = resolve }), resolve: () => release() }
    void ready.promise.catch(() => undefined)
    let work: Promise<unknown> | undefined
    const finish = () => released.resolve()
    signal.addEventListener('abort', finish, { once: true })
    const owner: SessionClaudeOwner = {
      start: (descriptor, cancellation) => {
        if (work || !current(input.threadId) || signal.aborted || cancellation.aborted) throw refused('query')
        const cancel = () => lifetime.abort()
        cancellation.addEventListener('abort', cancel, { once: true })
        const environment: Record<string, string> = {}
        for (const [key, value] of Object.entries(descriptor.env)) if (value !== undefined) environment[key] = value
        work = launch.withProvider(input.providerSessionId,
          { processPurpose: 'provider', command: descriptor.command, args: [...descriptor.args],
            cwd: descriptor.cwd!, environment }, async provider => {
          if (provider.driver !== 'claude' || provider.preparation.providerSessionId !== input.providerSessionId
            || signal.aborted || cancellation.aborted) throw refused('query')
          ready.resolve(provider)
          await released.promise
        }).catch(error => { ready.reject(error); throw error }).finally(() => {
          cancellation.removeEventListener('abort', cancel)
        })
        void work.catch(() => lifetime.abort())
        return ready.promise.then(provider => provider.process)
      },
      capture: encoded => {
        if (!current(input.threadId) || signal.aborted) throw refused('write')
        // The exact bytes and original launch/session owner are captured now,
        // even when the asynchronous native preparation has not returned yet.
        const bytes = Buffer.from(encoded, 'utf8')
        let used = false, captured: CapturedProviderFrame | undefined, writing: Promise<void> | undefined
        return {
          write: cancellation => {
            if (used || !current(input.threadId) || signal.aborted || cancellation.aborted) throw refused('write')
            used = true
            writing = (async () => {
              const provider = await ready.promise
              signal.throwIfAborted(); cancellation.throwIfAborted()
              if (!current(input.threadId)) throw refused('write')
              const frame = provider.serialization.capture(bytes.toString('utf8'))
              captured = frame
              await frame.write(cancellation)
              if (!current(input.threadId)) throw refused('write')
            })()
            return writing
          },
          async discard() {
            used = true
            try { await writing } finally {
              try { await captured?.discard() } finally { bytes.fill(0) }
            }
          },
        }
      },
    }
    // Install before opening the SDK's asynchronous native start. Its own Scope
    // finalizer joins parser/queue first; only then release the reserved callback.
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      lifetime.abort()
      released.resolve()
      try { await work } finally { signal.removeEventListener('abort', finish) }
    }))
    const session = yield* openProtectedOriginalClaudeQuery(input, owner, signal)
    return { ...session, messages: session.messages.pipe(Stream.tap(message =>
      OriginalClaudeProtocol.isClaudeTurnStartMessage(message)
        ? joinedNativeEffect(async () => { const provider = await ready.promise; await provider.associate() },
          () => refused('associate'))
        : Effect.void)) }
  }).pipe(Effect.provideService(Scope.Scope, scope))
  return OriginalClaudeRunner.ClaudeAgentSdkQueryRunner.of({
    allocateSessionId: Effect.suspend(() => current() ? random.uuidV4() : Effect.fail(refused('allocateSessionId'))),
    open,
    forkSession: input => current(input.threadId) ? history.forkSession(input) : Effect.fail(refused('forkSession')),
    subagentLaunchToolUseId: input => current(input.threadId)
      ? history.subagentLaunchToolUseId(input) : Effect.fail(refused('getSubagentMessages')),
    assertComplete: Effect.suspend(() => current() ? history.assertComplete : Effect.fail(refused('assertComplete'))),
  })
})
