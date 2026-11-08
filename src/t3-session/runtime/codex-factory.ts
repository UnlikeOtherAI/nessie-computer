import { win32 } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import { OriginalCodexFactory, OriginalCodexIdentity, OriginalCodexLaunch, OriginalProviderAdapter }
  from '@nessie/t3-session-source/engine'
import { ProviderDriverKind } from '@nessie/t3-session-source/contracts'
import type { ReservedSessionLaunch } from './native-launch.js'
import { makeProtectedOriginalCodexClient } from './codex-client.js'
import { joinedNativeEffect } from './native-effect.js'
import type { EffectValue } from './effect-types.js'

type Factory = OriginalCodexFactory.CodexAppServerClientFactoryShape
type OpenInput = Parameters<Factory['open']>[0]
type Client = EffectValue<ReturnType<Factory['open']>>
const refused = (input: OpenInput) => new OriginalProviderAdapter.ProviderAdapterOpenSessionError({
  driver: ProviderDriverKind.make('codex'), providerSessionId: input.providerSessionId,
  cause: new Error('T3_CODEX_ORIGINAL_HOST_REFUSED'),
})

/** Bound to one actual reserved original command. No global/default factory,
 * latest-grant lookup or daemon launch descriptor. The original adapter passes
 * its allocated providerSessionId; the service prepares and observes that ID.
 * Direct explicit Windows executables only; PATH/shell/AgentScope wrappers
 * need their own held resolution producer and are refused here. */
export const makeSessionCodexClientFactory = (launch: ReservedSessionLaunch):
  Effect.Effect<Factory, never, Scope.Scope> => Effect.gen(function* () {
  let opened = false, live = true
  yield* Effect.addFinalizer(() => Effect.sync(() => { live = false }))
  return OriginalCodexFactory.CodexAppServerClientFactory.of({
    open: input => Effect.gen(function* () {
      if (!live || opened || launch.signal.aborted || input.instanceId !== launch.target.providerInstanceId
        || input.threadId !== launch.target.threadId || input.settings.setupMode === 'managed'
        || input.settings.shadowHomePath.trim() || !input.settings.homePath.trim()
        || !win32.isAbsolute(input.settings.binaryPath)
        || win32.extname(input.settings.binaryPath).toLowerCase() !== '.exe') {
        return yield* Effect.fail(refused(input))
      }
      opened = true
      yield* launch.commandLineage.assertInitialMessage(input.threadId).pipe(Effect.mapError(() => refused(input)))
      const environment: Record<string, string> = {}
      for (const [key, value] of Object.entries(OriginalCodexIdentity.codexAppServerEnvironment(input.environment))) {
        if (value !== undefined) environment[key] = value
      }
      environment.CODEX_HOME = input.settings.homePath
      // The original factory omits ChildProcess.cwd. Capture that same host cwd
      // explicitly before native preparation; runtimePolicy.cwd is thread config.
      const descriptor = { processPurpose: 'provider' as const, command: input.settings.binaryPath,
        args: [...OriginalCodexLaunch.codexAppServerArgs(
          OriginalCodexLaunch.resolveCodexLaunchArgs(input.settings.launchArgs, input.environment))],
        cwd: process.cwd(), environment }
      const acquired = yield* Effect.acquireRelease(joinedNativeEffect(async interrupted => {
        let resolveReady!: (client: Client) => void, rejectReady!: (error: unknown) => void
        let release!: () => void
        const ready = new Promise<Client>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
        const finished = new Promise<void>(resolve => { release = resolve })
        const stop = () => release()
        const signal = AbortSignal.any([launch.signal, interrupted])
        signal.addEventListener('abort', stop, { once: true })
        const work = launch.withProvider(input.providerSessionId, descriptor, async provider => {
          const parserScope = await Effect.runPromise(Scope.make())
          try {
            signal.throwIfAborted()
            const client = await Effect.runPromise(makeProtectedOriginalCodexClient(provider).pipe(
              Effect.provideService(Scope.Scope, parserScope)), { signal })
            signal.throwIfAborted()
            resolveReady(client)
            await finished
          } finally {
            // Drain the real parser/encoder before the native callback returns
            // and terminates the provider. EOF never stands for Job clearance.
            await Effect.runPromise(Scope.close(parserScope, Exit.void))
          }
        })
        void work.catch(rejectReady)
        const close = async () => {
          release()
          try { await work } finally { signal.removeEventListener('abort', stop) }
        }
        try {
          if (signal.aborted) throw refused(input)
          const client = await ready
          signal.throwIfAborted()
          return { client, close }
        } catch {
          await close()
          throw refused(input)
        }
      }, () => refused(input)), acquired => Effect.promise(acquired.close))
      return acquired.client
    }),
  })
})
