import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import type * as SqlClient from 'effect/sql/SqlClient'
import { createSessionStateLayers, createSessionReadLayers, ThreadReadService,
  type SessionStateServices, SourceContracts as S } from '@nessie/t3-session-source/engine'
import type { RetainedCapturePorts } from '../import/capture.js'
import { retainedCaptureAuthority } from '../import/capture.js'
import type { T3SourceManifest } from '../import/manifest.js'
import { requireCapture } from '../state/sqlite.js'
import type { RetainedReadScope } from '../ownership/continuity.js'
import { withRetainedReadScope } from '../ownership/continuity.js'
import { pinCatalogSelection, type RetainedCatalogSelection, type RetainedCatalogReadScope } from './selection.js'
import type { ProvenT3Source } from '../import/manifest.js'
import type { CaptureDatabase } from '../state/sqlite.js'

/** Selected by the admitted dispatcher, never accepted as caller-supplied authority. */
export interface RetainedReadSelection {
  /** Required for a fresh source open; an actual held graph already owns admission. */
  readonly manifest?: T3SourceManifest
  readonly admittedRootKey: string
  readonly generation: string
  readonly physicalRootKey?: string
  readonly environmentId?: S.EnvironmentId
  readonly authorization?: 'catalog'
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
  readonly selection?: RetainedCatalogSelection
}

export type RetainedReadServices = SessionStateServices | SqlClient.SqlClient | ThreadReadService
export type RetainedCatalogReader = <A, E>(targets: 'catalog' | readonly S.ThreadId[],
  read: (service: ThreadReadService['Service'], selection?: RetainedCatalogSelection) =>
    Effect.Effect<A, E, RetainedReadServices>) => Effect.Effect<RetainedCatalogResult<A>, E>

/** Internal held-graph adapter. Source identity is still checked by the actual
 * canonical authority, using the original live physical callback. No new source
 * port or authorization producer is constructed for graph reuse.
 */
export interface HeldRetainedReadGraph {
  readonly signal: AbortSignal
  readonly source: ProvenT3Source
  readonly database: CaptureDatabase
  readonly physicalSourceRecheck: () => Promise<void>
  readonly stageReference: string
  recheck(): Promise<void>
  track<A>(operation: Promise<A>): Promise<A>
  evaluate<A, E>(effect: Effect.Effect<A, E, RetainedReadServices>, signal: AbortSignal): Promise<Exit.Exit<A, E>>
}

/** One callback-scoped, cancellable read over the published owned generation.
 * Existing producers retain authority; this helper creates none. Catalog callers
 * require the distinct canonical selection lease. Legacy exact-thread wrappers
 * retain their original continuity path. Denial is never an empty catalog.
 */
export function readRetainedEffect<A, E>(ports: RetainedCapturePorts, source: RetainedReadSelection,
  targets: 'catalog' | readonly S.ThreadId[],
  read: (service: ThreadReadService['Service'], selection?: RetainedCatalogSelection) =>
    Effect.Effect<A, E, RetainedReadServices>,
  held?: HeldRetainedReadGraph,
): Effect.Effect<RetainedCatalogResult<A>, E> {
  const execute = async (signal: AbortSignal) => {
    signal.throwIfAborted()
    const sourcePort = ports.source
    const owner = retainedCaptureAuthority(ports)
    const catalogAuthority = ports.catalogAuthority
    requireCapture((held || sourcePort) && (source.authorization === 'catalog' ? catalogAuthority : owner),
      'required_retained_read_producers')
    if (!held) requireCapture(source.manifest?.homes.some(home => home.admittedRootKey === source.admittedRootKey),
      'source_not_in_manifest')
    const withSource = async <B>(use: (proven: ProvenT3Source, database: CaptureDatabase,
      recheck: () => Promise<void>) => Promise<B>): Promise<B> => {
      if (held) {
        await held.recheck()
        const value = await use(held.source, held.database, held.physicalSourceRecheck)
        await held.recheck()
        return value
      }
      requireCapture(sourcePort, 'required_retained_read_producers')
      requireCapture(source.manifest, 'source_not_in_manifest')
      return sourcePort.withReadonlySource(source.manifest, source.admittedRootKey, use)
    }
    const completed = await withSource(async (proven, _database, recheck) => {
      requireCapture(proven.admittedRootKey === source.admittedRootKey, 'source_admission_mismatch')
      requireCapture((source.physicalRootKey === undefined || proven.physicalRootKey === source.physicalRootKey) &&
        (source.environmentId === undefined || proven.environmentId === source.environmentId),
        'capture_source_mismatch')
      const use = async (lease: RetainedReadScope, catalogLease?: RetainedCatalogReadScope) => {
        const selection = catalogLease && pinCatalogSelection(catalogLease.selection)
        const published = () => {
          signal.throwIfAborted()
          const root = ports.journal.root(proven.physicalRootKey)
          requireCapture(root?.environment_id === proven.environmentId && root.conflict === 0,
            'capture_history_source_conflict')
          ports.journal.requirePublished(proven.physicalRootKey, source.generation)
        }
        await recheck()
        await lease.recheckSource()
        await catalogLease?.recheckSelection()
        published()
        const granted = selection?.scope === 'threads' ? new Set(selection.threadIds) : undefined
        if (targets !== 'catalog' && granted) {
          requireCapture(targets.every(id => granted.has(id)), 'capture_read_forbidden')
        }
        // Never enumerate hidden identities to decide what the caller can see.
        const candidates = targets === 'catalog' ? granted && [...granted] : targets
        const identities = candidates === undefined ? ports.journal.catalog(proven.physicalRootKey)
          : candidates.flatMap(id => {
            const row = ports.journal.catalogIdentity(proven.physicalRootKey, id)
            return row ? [row] : []
          })
        const retained = new Set(identities.filter(row => row.source_state !== 'deleted').map(row => {
          requireCapture(typeof row.thread_id === 'string', 'capture_identity_invalid')
          return S.ThreadId.make(row.thread_id)
        }))
        const ids = targets === 'catalog' ? [...retained] : targets
        const checkThreads = async () => {
          for (const id of ids) {
            signal.throwIfAborted()
            requireCapture(retained.has(id), 'capture_history_tombstoned_or_unknown')
            // Catalog selection rechecks cover every issued share and the
            // whole-source grant. Exact-thread reads retain individual checks.
            if (targets !== 'catalog' || !catalogLease) await lease.recheckThread(id)
          }
        }
        await checkThreads()
        const job = ports.journal.generation(source.generation)
        requireCapture(job?.physical_root === proven.physicalRootKey && typeof job.stage_ref === 'string' &&
          typeof job.source_high_water === 'number', 'capture_history_not_ready')
        // Exit retains the original typed source failure. Lease failures remain
        // transport defects, never a fabricated successful source response.
        const program = Effect.gen(function* () {
          return yield* read(yield* ThreadReadService, selection)
        })
        const evaluate = async () => {
          if (held) {
            requireCapture(held.stageReference === job.stage_ref, 'capture_stage_mismatch')
            published()
            return held.evaluate(program, signal)
          }
          requireCapture(typeof job.stage_ref === 'string', 'capture_stage_mismatch')
          const stage = await ports.workspace.reopenGeneration(job.stage_ref)
          requireCapture(stage.reference === job.stage_ref, 'capture_stage_mismatch')
          published()
          const reads = createSessionReadLayers(createSessionStateLayers())
          return Effect.runPromise(Effect.scoped(Effect.exit(program.pipe(
            Effect.provide(reads.layer.pipe(Layer.provideMerge(Layer.orDie(stage.sql))))))), { signal })
        }
        const exit = await evaluate()
        await checkThreads()
        await catalogLease?.recheckSelection()
        await lease.recheckSource()
        await recheck()
        published()
        return { exit, sourceSequence: job.source_high_water, proven, selection }
      }
      if (source.authorization === 'catalog') {
        requireCapture(catalogAuthority, 'required_retained_catalog_authority')
        return catalogAuthority.withCatalogReadScope({ source: proven, physicalSourceRecheck: recheck,
          captureGeneration: source.generation, purpose: 'retained-catalog-read' }, lease => use(lease, lease))
      }
      requireCapture(owner, 'required_retained_read_producers')
      return withRetainedReadScope(owner, { source: proven, physicalSourceRecheck: recheck,
        captureGeneration: source.generation }, lease => use(lease))
    })
    signal.throwIfAborted()
    ports.journal.requirePublished(completed.proven.physicalRootKey, source.generation)
    return completed
  }
  return Effect.promise(signal => held ? held.track(execute(AbortSignal.any([signal, held.signal]))) : execute(signal))
    .pipe(Effect.flatMap(({ exit, sourceSequence, proven, selection }) => Exit.isFailure(exit)
    ? Effect.failCause(exit.cause)
    : Effect.succeed({ source: 't3' as const, physicalRootKey: proven.physicalRootKey,
      environmentId: proven.environmentId, captureGeneration: source.generation, sourceSequence,
      ...(selection ? { selection } : {}), value: exit.value })))
}
