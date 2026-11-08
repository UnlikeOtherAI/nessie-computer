import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { createSessionReadLayers, createSessionStateLayers } from '@nessie/t3-session-source/engine'
import type { ExecutorLocalState } from '../../state-store.js'
import type { RetainedCapturePorts } from '../import/capture.js'
import type { RetainedImportLocalContext } from '../ownership/import-scope.js'
import { sessionOperationScope } from '../runtime/operation-scope.js'
import { requireCapture } from '../state/sqlite.js'
import { composeRetainedCatalogService, type RetainedCatalogService } from './service.js'
import { createRetainedCatalogPublicationPort } from './publication.js'
import { readRetainedEffect, type HeldRetainedReadGraph, type RetainedReadServices } from './scope.js'
import type { RetainedCatalogAuthorityPort, RetainedCatalogPublicationAuthorityPort } from './selection.js'
import type { T3CatalogPublicationReceipt } from '@nessie/executor-protocol/t3-session'
import type { LocalCatalogCapture } from './publication-scope.js'

export interface HeldRetainedCatalogGraph extends LocalCatalogCapture {
  readonly readiness: 'retained-read-only'
  readonly signal: AbortSignal
  recheck(): Promise<void>
  createReadService(authority: RetainedCatalogAuthorityPort): RetainedCatalogService
  publish(authority: RetainedCatalogPublicationAuthorityPort, state: () => ExecutorLocalState,
    signal?: AbortSignal): Promise<T3CatalogPublicationReceipt>
}

/** Call inside withRetainedRuntimeSource, passing its sticky-abort signal. That
 * wrapper keeps the actual source/consent alive at <=20s intervals while this
 * graph waits on SQL or transport. Server/consent hard deadlines are not renewed.
 *
 * One destination acquisition and one original read graph cover the callback.
 * Operations are joined before SQLite closes. The callback must drain its lane
 * when graph.signal aborts; no handler or authority may outlive this callback.
 * This readiness is passive history only: no executing lifecycle, provenance,
 * native association, writer transfer or provider startup is asserted.
 */
export async function withHeldRetainedCatalogGraph<A>(ports: RetainedCapturePorts,
  local: RetainedImportLocalContext, use: (graph: HeldRetainedCatalogGraph) => Promise<A>,
  callerSignal: AbortSignal): Promise<A> {
  const lifetime = new AbortController()
  const signal = AbortSignal.any([callerSignal, lifetime.signal])
  const pending = new Set<Promise<unknown>>()
  const track = <T>(operation: Promise<T>): Promise<T> => {
    const joined = operation.finally(() => { pending.delete(joined) })
    pending.add(joined)
    return joined
  }
  let active = true
  let failed = false
  let failure: unknown
  const recheck = async () => {
    try {
      signal.throwIfAborted()
      requireCapture(active, 'retained_catalog_graph_closed')
      await local.physicalSourceRecheck()
      signal.throwIfAborted()
      await local.recheckLocalConsent()
      signal.throwIfAborted()
      requireCapture(active, 'retained_catalog_graph_closed')
      requireCapture(ports.journal.root(local.source.physicalRootKey)?.environment_id === local.source.environmentId,
        'capture_source_mismatch')
      ports.journal.requirePublished(local.source.physicalRootKey, local.captureGeneration)
    } catch (error) {
      // A recovered callback cannot revive dependent reads after source loss.
      if (active && !failed) { failed = true; failure = error }
      lifetime.abort(error)
      throw error
    }
  }
  try {
    await recheck()
    const job = ports.journal.generation(local.captureGeneration)
    requireCapture(job?.physical_root === local.source.physicalRootKey && typeof job.stage_ref === 'string' &&
      typeof job.source_high_water === 'number' && Number.isSafeInteger(job.source_high_water) &&
      job.source_high_water >= 0, 'capture_history_not_ready')
    const capture: LocalCatalogCapture = Object.freeze({ source: local.source, captureGeneration: local.captureGeneration,
      sourceHighWater: job.source_high_water, localCatalogReference: job.stage_ref })
    const stage = await ports.workspace.reopenGeneration(capture.localCatalogReference)
    requireCapture(stage.reference === capture.localCatalogReference, 'capture_stage_mismatch')
    await recheck()
    const reads = createSessionReadLayers(createSessionStateLayers())
    const run = Effect.gen(function* () {
      const bind = yield* sessionOperationScope<RetainedReadServices>()
      const held: HeldRetainedReadGraph = {
        signal,
        source: local.source, database: local.database, physicalSourceRecheck: local.physicalSourceRecheck,
        stageReference: capture.localCatalogReference, recheck, track,
        evaluate: async (effect, operationSignal) => {
          await recheck()
          const exit = await Effect.runPromise(Effect.exit(bind(effect)), {
            signal: AbortSignal.any([signal, operationSignal]),
          })
          await recheck()
          return exit
        },
      }
      const source = { ...local.source, generation: local.captureGeneration, authorization: 'catalog' as const }
      const graph: HeldRetainedCatalogGraph = Object.freeze({ ...capture, readiness: 'retained-read-only', signal,
        recheck: () => track(recheck()),
        createReadService: (authority: RetainedCatalogAuthorityPort) => composeRetainedCatalogService(source,
          (targets, query) => readRetainedEffect({ ...ports, catalogAuthority: authority }, source, targets, query, held)),
        publish: (authority: RetainedCatalogPublicationAuthorityPort, state: () => ExecutorLocalState,
          operationSignal?: AbortSignal) => track(createRetainedCatalogPublicationPort(ports, local, held, authority, state)
          .publishLocalCapture(capture, { signal: operationSignal ? AbortSignal.any([signal, operationSignal]) : signal })),
      })
      // A Promise callback is cooperatively cancelled through graph.signal, then
      // drained. Detaching it on abort would close SQL while its lane still runs.
      return yield* Effect.promise(() => use(graph)).pipe(Effect.uninterruptible,
        Effect.ensuring(Effect.promise(async () => {
          active = false
          lifetime.abort(new Error('retained_catalog_graph_closed'))
          // Include enclosing authority/transport promises, not just the SQL
          // fiber: their final checks must finish before source release.
          while (pending.size) await Promise.allSettled([...pending])
        })))
    })
    const exit = await Effect.runPromise(Effect.scoped(Effect.exit(run.pipe(
      Effect.provide(reads.layer.pipe(Layer.provideMerge(Layer.orDie(stage.sql))))))), { signal: callerSignal })
    if (Exit.isFailure(exit)) return await Effect.runPromise(Effect.failCause(exit.cause))
    if (failed) throw failure
    callerSignal.throwIfAborted()
    ports.journal.requirePublished(local.source.physicalRootKey, local.captureGeneration)
    return exit.value
  } finally { active = false; lifetime.abort(new Error('retained_catalog_graph_closed')) }
}
