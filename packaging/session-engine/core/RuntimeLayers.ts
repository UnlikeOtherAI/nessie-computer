import * as Layer from 'effect/Layer'
import { createSessionStateLayers } from './StateLayers.ts'
import { createSessionEngineLayers } from './EngineLayers.ts'
import { sessionLifecycleLayer } from './SessionLifecycle.ts'

/**
 * Execution composition, never a provider-admission boundary. The caller must
 * acquire its native runtime custody and state writer before building this
 * layer. Missing provider/resource services remain real Layer requirements.
 * One state object supplies every store, outbox and post-commit wakeup lane.
 */
export const createSessionRuntimeLayers = (state = createSessionStateLayers()) => {
  const engine = createSessionEngineLayers(state)
  const services = Layer.mergeAll(engine.launch, engine.recovery, engine.worker)
  const layer = sessionLifecycleLayer.pipe(Layer.provideMerge(services))
  return { state, engine, services, layer }
}

export { SessionEngineLifecycle, SessionLifecycleError } from './SessionLifecycle.ts'
export * as ProviderHost from 't3-source:packages/provider-core/src/server/ProviderHost.ts'
export * as NativeChildProcesses from 'effect/process/ChildProcessSpawner'
