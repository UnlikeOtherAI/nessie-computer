import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import type * as SqlClient from 'effect/sql/SqlClient'
import { createSessionStateLayers, createSessionReadLayers, ThreadReadService,
  type SessionStateServices, SourceContracts as S } from '@nessie/t3-session-source/engine'
import type { RetainedCapturePorts } from '../import/capture.js'
import type { T3SourceManifest } from '../import/manifest.js'
import { requireCapture } from '../state/sqlite.js'

/** Selected by the admitted dispatcher, never accepted as caller-supplied authority. */
export interface RetainedReadSelection {
  readonly manifest: T3SourceManifest
  readonly admittedRootKey: string
  readonly generation: string
  readonly physicalRootKey?: string
  readonly environmentId?: S.EnvironmentId
}

export interface RetainedCatalogSource extends RetainedReadSelection {
  readonly physicalRootKey: string
  readonly environmentId: S.EnvironmentId
}

export interface RetainedCatalogResult<A> {
  readonly source: 't3'
  readonly physicalRootKey: string
  readonly environmentId: S.EnvironmentId
  readonly captureGeneration: string
  /** Original source high-water; value.snapshotSequence remains the engine sequence. */
  readonly sourceSequence: number
  readonly value: A
}

type ReadServices = SessionStateServices | SqlClient.SqlClient

/** One callback-scoped, cancellable read over the published owned generation.
 * Existing producers retain authority; this helper creates none. Until a canonical
 * entitled-row projector exists, catalog reads require access to every retained
 * nondeleted identity. Denial must never be interpreted as an empty catalog.
 */
export function readRetainedEffect<A, E>(ports: RetainedCapturePorts, source: RetainedReadSelection,
  targets: 'catalog' | readonly S.ThreadId[],
  read: (service: ThreadReadService['Service']) => Effect.Effect<A, E, ReadServices>,
): Effect.Effect<RetainedCatalogResult<A>, E> {
  return Effect.promise(async signal => {
    signal.throwIfAborted()
    const sourcePort = ports.source
    const owner = ports.originalOwner
    requireCapture(sourcePort && owner, 'required_retained_read_producers')
    requireCapture(source.manifest.homes.some(home => home.admittedRootKey === source.admittedRootKey),
      'source_not_in_manifest')
    const completed = await sourcePort.withReadonlySource(source.manifest, source.admittedRootKey,
      async (proven, _database, recheck) => {
      requireCapture((source.physicalRootKey === undefined || proven.physicalRootKey === source.physicalRootKey) &&
        (source.environmentId === undefined || proven.environmentId === source.environmentId),
        'capture_source_mismatch')
      return owner.withReadScope({ source: proven, physicalSourceRecheck: recheck,
        captureGeneration: source.generation, purpose: 'retained-history-read' }, async lease => {
        const published = () => {
          signal.throwIfAborted()
          const root = ports.journal.root(proven.physicalRootKey)
          requireCapture(root?.environment_id === proven.environmentId && root.conflict === 0,
            'capture_history_source_conflict')
          ports.journal.requirePublished(proven.physicalRootKey, source.generation)
        }
        await recheck()
        await lease.recheckSource()
        published()
        const identities = ports.journal.catalog(proven.physicalRootKey)
        const retained = new Set(identities.filter(row => row.source_state !== 'deleted').map(row => {
          requireCapture(typeof row.thread_id === 'string', 'capture_identity_invalid')
          return S.ThreadId.make(row.thread_id)
        }))
        const ids = targets === 'catalog' ? [...retained] : targets
        const checkThreads = async () => {
          for (const id of ids) {
            signal.throwIfAborted()
            requireCapture(retained.has(id), 'capture_history_tombstoned_or_unknown')
            await lease.recheckThread(id)
          }
        }
        await checkThreads()
        const job = ports.journal.generation(source.generation)
        requireCapture(job?.physical_root === proven.physicalRootKey && typeof job.stage_ref === 'string' &&
          typeof job.source_high_water === 'number', 'capture_history_not_ready')
        const stage = await ports.workspace.reopenGeneration(job.stage_ref)
        requireCapture(stage.reference === job.stage_ref, 'capture_stage_mismatch')
        published()
        const state = createSessionStateLayers()
        const reads = createSessionReadLayers(state)
        // Exit retains the original typed source failure. Lease failures remain
        // transport defects, never a fabricated successful source response.
        const exit = await Effect.runPromise(Effect.scoped(Effect.exit(Effect.gen(function* () {
          return yield* read(yield* ThreadReadService)
        }).pipe(Effect.provide(reads.layer.pipe(Layer.provideMerge(Layer.orDie(stage.sql))))))), { signal })
        await checkThreads()
        await lease.recheckSource()
        await recheck()
        published()
        return { exit, sourceSequence: job.source_high_water, proven }
      })
    })
    signal.throwIfAborted()
    ports.journal.requirePublished(completed.proven.physicalRootKey, source.generation)
    return completed
  }).pipe(Effect.flatMap(({ exit, sourceSequence, proven }) => Exit.isFailure(exit)
    ? Effect.failCause(exit.cause)
    : Effect.succeed({ source: 't3' as const, physicalRootKey: proven.physicalRootKey,
      environmentId: proven.environmentId, captureGeneration: source.generation, sourceSequence, value: exit.value })))
}
