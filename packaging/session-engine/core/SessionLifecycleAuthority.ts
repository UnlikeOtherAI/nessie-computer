import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'
import type * as Recovery from 't3-source:apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.session-api.ts'
import type * as Legacy from 't3-source:apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts'
import type { OrchestrationEffectClaimDeadline } from 't3-source:apps/server/src/orchestration-v2/EffectOutbox.ts'

export type SessionLifecycleAction = 'legacy-shell-reconcile' | 'runtime-recover' | 'delegated-task-recover'
  | 'prepare-shutdown' | 'runtime-reconcile-shutdown'

export class SessionLifecycleActionRefused extends Error {
  constructor() { super('T3_SESSION_LIFECYCLE_ACTION_REFUSED'); this.name = 'SessionLifecycleActionRefused' }
}

/** Required current owner for these concrete original SQL/event mutations.
 * Graph retention, reserve and a row-preclaim grant do not provide this service.
 * There is no default, native producer or blanket imported-row recovery grant. */
export class SessionLifecycleAuthority extends Context.Service<SessionLifecycleAuthority, {
  readonly withAction: <A, E, R>(action: Exclude<SessionLifecycleAction, 'prepare-shutdown' | 'legacy-shell-reconcile'>,
    original: Effect.Effect<A, E, R>) =>
    Effect.Effect<A, E | SessionLifecycleActionRefused, R>
  readonly withLegacyShellReconciliation: <A, E, R>(candidate: Legacy.LegacyShellReconciliationCandidate,
    original: (deadline: OrchestrationEffectClaimDeadline) => Effect.Effect<A, E, R>) =>
    Effect.Effect<A, E | SessionLifecycleActionRefused, R>
  /** Current native/backend owner admits the complete actual candidate before
   * invoking its writer with the independently consumed deadline. */
  readonly withShutdownPreparation: <A, E, R>(candidate: Recovery.ShutdownPreparationCandidate,
    original: (deadline: OrchestrationEffectClaimDeadline) => Effect.Effect<A, E, R>) =>
    Effect.Effect<A, E | SessionLifecycleActionRefused, R>
}>()('nessie/t3-session/SessionLifecycleAuthority') {}

/** Keep the actual original result and join its finite work. An owner cannot
 * skip a required operation, replace a failure, call it twice or retain a live
 * mutation callback after its admission attempt has returned. */
const withFiniteLifecycleAction = <I, A, E, R>(
  use: (original: (input: I) => Effect.Effect<A, E | SessionLifecycleActionRefused, R>) =>
    Effect.Effect<A, E | SessionLifecycleActionRefused, R>,
  original: (input: I) => Effect.Effect<A, E, R>):
  Effect.Effect<A, E | SessionLifecycleActionRefused, Exclude<R, Scope.Scope>> => Effect.scoped(
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    let live = true, called = false
    let result: { readonly value: A } | undefined
    const guarded = (input: I) => Effect.suspend<A, E | SessionLifecycleActionRefused, R>(() => {
      if (!live || called) return Effect.fail(new SessionLifecycleActionRefused())
      called = true
      // Even an owner that detaches its wait cannot detach the original SQL
      // operation: its child is retained in this finite action's Scope.
      return original(input).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join),
        Effect.tap(value => Effect.sync(() => { result = { value } })))
    })
    return yield* use(guarded).pipe(Effect.flatMap(value =>
      result !== undefined && Object.is(value, result.value)
        ? Effect.succeed(value) : Effect.fail(new SessionLifecycleActionRefused())),
    Effect.ensuring(Effect.sync(() => { live = false })))
  }),
)

export const withSessionLifecycleAction = <A, E, R>(authority: SessionLifecycleAuthority['Service'],
  action: Exclude<SessionLifecycleAction, 'prepare-shutdown' | 'legacy-shell-reconcile'>,
  original: Effect.Effect<A, E, R>):
  Effect.Effect<A, E | SessionLifecycleActionRefused, Exclude<R, Scope.Scope>> =>
  withFiniteLifecycleAction<undefined, A, E, R>(
    guarded => authority.withAction(action, guarded(undefined)), () => original)

/** Observe the complete actual action in the original graph before its owner
 * can admit the conditional writer. Neither candidate nor deadline is authority. */
export const withSessionLegacyShellReconciliation = (authority: SessionLifecycleAuthority['Service'],
  importer: Legacy.LegacyV1ThreadImporter['Service']):
  Effect.Effect<Legacy.LegacyV1ImportSummary, Legacy.LegacyV1ThreadImportError | SessionLifecycleActionRefused> =>
  Effect.scoped(Effect.gen(function* () {
    const candidate = yield* importer.prepareShellReconciliation
    return yield* withFiniteLifecycleAction<OrchestrationEffectClaimDeadline, Legacy.LegacyV1ImportSummary,
      Legacy.LegacyV1ThreadImportError, never>(
        guarded => authority.withLegacyShellReconciliation(candidate, guarded),
        deadline => importer.reconcileShellsPrepared({ candidate, ...deadline }))
  }))

/** Use the whole prepared action. A fresh finite Scope also survives an
 * enclosing graph entering Closed before its shutdown finalizer runs. */
export const withSessionShutdownPreparation = (authority: SessionLifecycleAuthority['Service'],
  recovery: Recovery.ProviderRuntimeRecoveryService['Service']):
  Effect.Effect<void, Recovery.ProviderRuntimeRecoveryError | SessionLifecycleActionRefused> => Effect.scoped(
  Effect.gen(function* () {
    const candidate = yield* recovery.prepareShutdownPlan
    return yield* withFiniteLifecycleAction<OrchestrationEffectClaimDeadline, void,
      Recovery.ProviderRuntimeRecoveryError, never>(
        guarded => authority.withShutdownPreparation(candidate, guarded),
        deadline => recovery.prepareForShutdownPrepared({ candidate, ...deadline }))
  }),
)
