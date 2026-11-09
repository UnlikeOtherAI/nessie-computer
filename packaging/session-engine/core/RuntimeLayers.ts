import * as Layer from 'effect/Layer'
import * as Effect from 'effect/Effect'
import { createSessionStateLayers } from './StateLayers.ts'
import { createSessionEngineLayers, type SessionEngineLayers } from './EngineLayers.ts'
import { sessionLifecycleLayer } from './SessionLifecycle.ts'
import { sessionResourceCleanupLayer } from './ResourceLayers.ts'
import { SessionLifecycleAuthority } from './SessionLifecycleAuthority.ts'

/**
 * Execution composition, never a provider-admission boundary. The caller must
 * acquire its native runtime custody and state writer before building this
 * layer. Missing provider/resource services remain real Layer requirements.
 * One state object supplies every store, outbox and post-commit wakeup lane.
 */
export const composeSessionRuntimeLayers = <R>(state: ReturnType<typeof createSessionStateLayers>,
  engine: SessionEngineLayers<R>) => {
  const host = sessionResourceCleanupLayer
  const services = Layer.mergeAll(engine.launch, engine.recovery, engine.worker).pipe(
    Layer.provideMerge(Layer.mergeAll(host, engine.finalization)),
  )
  // Resolve the required owner before building the effectful original hosts,
  // rather than discovering missing startup authority after construction.
  const layer = Layer.unwrap(Effect.map(SessionLifecycleAuthority,
    () => sessionLifecycleLayer.pipe(Layer.provideMerge(services))))
  return { state, engine, host, services, layer }
}

export const createSessionRuntimeLayers = (state = createSessionStateLayers(),
  engine = createSessionEngineLayers(state)) => composeSessionRuntimeLayers(state, engine)

export { SessionEngineLifecycle, SessionLifecycleError } from './SessionLifecycle.ts'
export * as SessionLifecycle from './SessionLifecycle.ts'
export { SessionLifecycleAuthority, SessionLifecycleActionRefused, withSessionLifecycleAction,
  withSessionLegacyShellReconciliation, withSessionShutdownPreparation }
  from './SessionLifecycleAuthority.ts'
export type { SessionLifecycleAction } from './SessionLifecycleAuthority.ts'
export * as ProviderHost from 't3-source:packages/provider-core/src/server/ProviderHost.ts'
export * as NativeChildProcesses from 'effect/process/ChildProcessSpawner'
