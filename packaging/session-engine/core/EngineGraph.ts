import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type * as Context from 'effect/Context'
import * as LegacyImporter from 't3-source:apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts'
import { createSessionEngineLayers, createSessionEngineLayersWithAdapters, type SessionEngineLayers }
  from './EngineLayers.ts'
import { createSessionStateLayers } from './StateLayers.ts'
import { composeSessionRuntimeLayers } from './RuntimeLayers.ts'

export class SessionEngineGraphClosed extends Error {
  constructor() { super('T3_SESSION_ENGINE_GRAPH_CLOSED'); this.name = 'SessionEngineGraphClosed' }
}

/** One owner scope and memo map across cold inspection and admitted activation.
 * Creating this owner builds no layer. Each returned effect still requires its
 * actual original host services; this owner confers no execution authority.
 * The enclosing runtime must interrupt/join demand before closing its scope.
 */
const makeSessionGraph = <R>(createLayers: (state: ReturnType<typeof createSessionStateLayers>) =>
  SessionEngineLayers<R>) => Effect.gen(function* () {
  const scope = yield* Effect.scope
  const memo = yield* Layer.makeMemoMap
  const layers = createLayers(createSessionStateLayers())
  const runtime = composeSessionRuntimeLayers(layers.state, layers)
  let open = true
  yield* Effect.addFinalizer(() => Effect.sync(() => { open = false }))
  const build = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
    Effect.suspend<Context.Context<A>, E | SessionEngineGraphClosed, R>(() =>
    open ? Layer.buildWithMemoMap(layer, memo, scope) : Effect.fail(new SessionEngineGraphClosed()))
  return {
    inspection: build(layers.inspection),
    legacyShells: build(LegacyImporter.layer.pipe(Layer.provide(layers.state.layer))),
    activate: build(runtime.layer),
    launch: build(layers.launch),
    recovery: build(layers.recovery),
    worker: build(layers.worker),
    continuationConsumer: build(layers.continuationConsumer),
    finalization: build(layers.finalization),
  }
})

export const makeSessionEngineGraph = makeSessionGraph(createSessionEngineLayers)
export const makeSessionEngineGraphWithAdapters = makeSessionGraph(createSessionEngineLayersWithAdapters)
