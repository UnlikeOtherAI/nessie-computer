// Session ordering follows serverRuntimeStartup.ts at T3 25bf84ab (MIT).
// Application listeners, boot services, welcome setup and telemetry are excluded.
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as ProviderHost from 't3-source:packages/provider-core/src/server/ProviderHost.ts'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import * as LegacyImporter from 't3-source:apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts'
import * as Orchestrator from 't3-source:apps/server/src/orchestration-v2/Orchestrator.ts'
import * as Sessions from 't3-source:apps/server/src/orchestration-v2/ProviderSessionManager.session-port.ts'
import * as Recovery from 't3-source:apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts'
import * as Continuations from 't3-source:apps/server/src/orchestration-v2/ProviderContinuationService.ts'
import * as Worker from 't3-source:apps/server/src/orchestration-v2/EffectWorker.ts'
import { SessionLifecycleAuthority, withSessionLifecycleAction } from './SessionLifecycleAuthority.ts'

type Phase = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'

export class SessionLifecycleError extends Schema.TaggedError<SessionLifecycleError>()(
  'SessionLifecycleError', { phase: Schema.String, cause: Schema.Defect() },
) {}

/** Internal machine lifecycle. Its state is not human admission or native stop proof. */
export class SessionEngineLifecycle extends Context.Service<SessionEngineLifecycle, {
  readonly phase: Effect.Effect<Phase>
  readonly assertRunning: Effect.Effect<void, SessionLifecycleError>
  readonly awaitFailure: Effect.Effect<never, SessionLifecycleError>
  readonly stop: Effect.Effect<void, SessionLifecycleError>
}>()('nessie/t3-session/SessionEngineLifecycle') {}

const make = Effect.gen(function* () {
  const authority = yield* SessionLifecycleAuthority
  // Requiring the original tags prevents an accidentally providerless composition.
  // Their production implementations must come from the admitted host, never NodeServices.layer.
  yield* ProviderHost.ProviderHost
  yield* ChildProcessSpawner.ChildProcessSpawner
  const importer = yield* LegacyImporter.LegacyV1ThreadImporter
  const recovery = yield* Recovery.ProviderRuntimeRecoveryService
  const orchestrator = yield* Orchestrator.OrchestratorV2
  const sessions = yield* Sessions.ProviderSessionManagerV2
  yield* Worker.OrchestrationEffectWorkerV2
  const phase = yield* Ref.make<Phase>('starting')
  const failure = yield* Deferred.make<never, SessionLifecycleError>()
  const consumers = yield* Scope.make('sequential')

  // Install cleanup before the first recovery write. A failed startup never
  // publishes running and still closes any already acquired consumer resources.
  const stop = yield* Effect.cached(Effect.uninterruptible(Effect.gen(function* () {
    yield* Ref.set(phase, 'stopping')
    // Stop continuation intake and the worker before preparing restart intents.
    // Keep SQL, providers and the state writer alive through reconciliation.
    const closed = yield* Effect.exit(Scope.close(consumers, Exit.void))
    const prepared = Exit.isSuccess(closed) ? yield* Effect.exit(withSessionLifecycleAction(
      authority, 'prepare-shutdown', recovery.prepareForShutdown)) : closed
    const stopped = yield* Effect.exit(sessions.shutdown)
    // A provider shutdown defect must not be turned into a recorded stop.
    const reconciled = Exit.isSuccess(closed) && Exit.isSuccess(prepared) && Exit.isSuccess(stopped)
      ? yield* Effect.exit(withSessionLifecycleAction(authority, 'runtime-reconcile-shutdown',
        recovery.reconcile('shutdown').pipe(Effect.asVoid))) : stopped
    const failed = [closed, prepared, stopped, reconciled].find(Exit.isFailure)
    if (failed && Exit.isFailure(failed)) {
      yield* Ref.set(phase, 'failed')
      return yield* new SessionLifecycleError({ phase: 'shutdown', cause: failed.cause })
    }
    yield* Ref.set(phase, 'stopped')
  })))
  // Retain errors: a failed cleanup is not a successful shutdown receipt.
  yield* Effect.addFinalizer(() => stop.pipe(Effect.orDie))

  yield* withSessionLifecycleAction(authority, 'legacy-shell-reconcile', importer.reconcileShells)
  yield* withSessionLifecycleAction(authority, 'runtime-recover', recovery.recover)
  yield* withSessionLifecycleAction(authority, 'delegated-task-recover', orchestrator.recoverDelegatedTasks)
  // Build ONLY the consumer here, with the already built original services.
  // Providing engine.continuationConsumer here would rebuild its dependencies
  // in another Layer memo map and create a second outbox/command lock.
  yield* Layer.build(Continuations.layer).pipe(Effect.provideService(Scope.Scope, consumers))
  const started = yield* Deferred.make<void>()
  yield* Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined)
    yield* Worker.runDaemon
  }).pipe(
    Effect.onExit(exit => Effect.gen(function* () {
      const current = yield* Ref.get(phase)
      if (current === 'stopping' || current === 'stopped') return
      yield* Ref.set(phase, 'failed')
      yield* Deferred.fail(failure, new SessionLifecycleError({ phase: 'worker',
        cause: Exit.isFailure(exit) ? exit.cause : 'worker_ended' }))
    })),
    Effect.forkScoped,
    Effect.provideService(Scope.Scope, consumers),
  )
  yield* Deferred.await(started)
  // Never overwrite a worker failure observed during the startup handoff.
  const current = yield* Ref.getAndUpdate(phase, value => value === 'starting' ? 'running' : value)
  if (current !== 'starting') return yield* new SessionLifecycleError({ phase: 'startup', cause: current })
  return SessionEngineLifecycle.of({
    phase: Ref.get(phase), stop, awaitFailure: Deferred.await(failure),
    assertRunning: Ref.get(phase).pipe(Effect.flatMap(value => value === 'running'
      ? Effect.void : Effect.fail(new SessionLifecycleError({ phase: value, cause: 'runtime_not_running' })))),
  })
})

export const sessionLifecycleLayer = Layer.effect(SessionEngineLifecycle, make)
