import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import type { SqlError } from 'effect/sql/SqlError'
import { ApplicationEvents, ProjectStore, ProjectionStore, ShellStream, ThreadStream, HistoryPaging, WireProjection,
  type ThreadReadService, SourceContracts as S } from '@nessie/t3-session-source/engine'
import type { RetainedCatalogInput, RetainedCatalogOutput } from './operations.js'
import type { RetainedReadServices } from './scope.js'
import type { ExecutorT3HttpEndpoints } from '@nessie/executor-protocol/t3-session'
import type { RetainedCatalogSelection } from './selection.js'
import { requireCapture } from '../state/sqlite.js'

type Reads = ThreadReadService['Service']
type ShellRead = ReturnType<Reads['readShellSnapshot']>
type ReadMethod = Extract<Reads[keyof Reads], (...args: never[]) => unknown>
export type RetainedCatalogReadError = Effect.Error<ReturnType<ReadMethod>>
  | SqlError
  | Effect.Error<Effect.Success<ShellRead>>
  | Effect.Error<ReturnType<ProjectStore.ProjectStoreV2['Service']['listShells']>>
  | Effect.Error<ApplicationEvents.OrchestrationEventStore['Service']['latestApplicationSequence']>
  | Effect.Error<ReturnType<ProjectionStore.ProjectionStoreV2['Service']['listActiveShellIndex']>>
type Query<A> = Effect.Effect<A, RetainedCatalogReadError, RetainedReadServices>
type HttpResult<K extends keyof typeof ExecutorT3HttpEndpoints> = typeof ExecutorT3HttpEndpoints[K]['~Success']['Type']

/** Original shell transaction, trims and tie rules; no scanner or timestamp cutoff. */
export const shellSnapshot = (reads: Reads, options: {
  readonly omitIdleSubagents: boolean; readonly omitOlderSettled: boolean
}, selection?: RetainedCatalogSelection): Query<S.OrchestrationV2ShellSnapshot> => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projects = yield* ProjectStore.ProjectStoreV2
  const events = yield* ApplicationEvents.OrchestrationEventStore
  requireCapture(selection, 'required_retained_catalog_selection')
  requireCapture(ProjectionStore.RETAINED_CATALOG_THREAD_FILTER_VERSION === 1,
    'required_entitled_shell_selector')
  const projection = yield* ProjectionStore.ProjectionStoreV2
  const scoped = selection.scope === 'threads' ? selection : undefined
  const listShellIndex: Effect.Effect<Effect.Success<ReturnType<Reads['listActiveShellIndex']>>,
    RetainedCatalogReadError> = scoped
      ? projection.listActiveShellIndex(scoped.threadIds) : reads.listActiveShellIndex()
  // Keep the original subscriber's single shared trim-facts calculation. Both
  // the index and subsequent shell query see only the entitled source subset.
  const { snapshot } = yield* ShellStream.loadSubscriberShellSnapshot({ sql,
    listShellIndex,
    readThreads: threadIds => reads.readShellSnapshot({ location: 'active',
      ...((threadIds ?? scoped?.threadIds) === undefined ? {} : { threadIds: threadIds ?? scoped?.threadIds }) }),
    listProjects: projects.listShells(scoped ? { projectIds: scoped.projectIds } : undefined),
    latestSequence: events.latestApplicationSequence, options })
  return snapshot
})

export const archivedSnapshot = (reads: Reads, selection?: RetainedCatalogSelection):
  Query<RetainedCatalogOutput<'orchestration.getArchivedShellSnapshot'>> => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projects = yield* ProjectStore.ProjectStoreV2
  const events = yield* ApplicationEvents.OrchestrationEventStore
  requireCapture(selection, 'required_retained_catalog_selection')
  const scoped = selection.scope === 'threads' ? selection : undefined
  const parts = yield* ShellStream.loadShellSnapshotParts({ sql,
    readThreads: reads.readShellSnapshot({ location: 'archive', ...(scoped ? { threadIds: scoped.threadIds } : {}) }),
    listProjects: projects.listShells(scoped ? { projectIds: scoped.projectIds } : undefined),
    latestSequence: events.latestApplicationSequence })
  return { schemaVersion: parts.threads.schemaVersion, snapshotSequence: parts.snapshotSequence,
    projects: parts.projects, threads: parts.threads.archivedThreads }
})

export const familyRows = (reads: Reads, options: { readonly familyOf: RetainedCatalogInput<
  'orchestration.getThreadFamily'>['threadId'] } | { readonly worktreePath: string },
selection?: RetainedCatalogSelection): Query<RetainedCatalogOutput<'orchestration.getThreadFamily'>> =>
  Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* ApplicationEvents.OrchestrationEventStore
  requireCapture(selection, 'required_retained_catalog_selection')
  const scoped = selection.scope === 'threads' ? selection : undefined
  // The original family lookup reads its requested member to resolve the root.
  // Refuse an ungranted input before invoking that lookup (unknown and hidden
  // IDs receive the same failure, with no existence probe).
  if (scoped && 'familyOf' in options) {
    requireCapture(scoped.threadIds.includes(options.familyOf), 'capture_read_forbidden')
  }
  const { threads, snapshotSequence } = yield* ShellStream.loadShellSnapshotParts({ sql,
    readThreads: reads.readShellSnapshot({ location: 'active', ...options,
      ...(scoped ? { threadIds: scoped.threadIds } : {}) }),
    listProjects: Effect.succeed([]), latestSequence: events.latestApplicationSequence })
  return { snapshotSequence, threads: threads.threads }
})

export const olderSettled = (reads: Reads,
  input: RetainedCatalogInput<'orchestration.getOlderSettledThreads'>,
  selection?: RetainedCatalogSelection): Query<RetainedCatalogOutput<'orchestration.getOlderSettledThreads'>> =>
  Effect.gen(function* () {
  requireCapture(selection, 'required_retained_catalog_selection')
  requireCapture(ProjectionStore.RETAINED_CATALOG_THREAD_FILTER_VERSION === 1,
    'required_entitled_older_settled_selector')
  const sql = yield* SqlClient.SqlClient
  const events = yield* ApplicationEvents.OrchestrationEventStore
  const query = { ...input, ...(selection.scope === 'threads' ? { threadIds: selection.threadIds } : {}) }
  return yield* ShellStream.loadOlderSettledThreadsPage({ sql, listThreads: reads.listOlderSettledThreads(query),
    readThreads: threadIds => reads.readShellSnapshot({ location: 'active', threadIds }),
    latestSequence: events.latestApplicationSequence })
})

export const boundedSnapshot = (reads: Reads, threadId: Parameters<Reads['getThreadSnapshotWindow']>[0],
  options: { readonly deferWork?: boolean; readonly compactTurnItems?: boolean;
    readonly dedupeBodies?: boolean; readonly compactIds?: boolean }): Query<HttpResult<'threadBoundedSnapshot'>> =>
  Effect.gen(function* () {
  const snapshot = yield* reads.getThreadSnapshotWindow(threadId, {
    rowLimit: HistoryPaging.THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
    userTurnLimit: HistoryPaging.THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
    deferWork: options.deferWork === true,
  })
  const bounded = HistoryPaging.buildBoundedThreadProjection({
    projection: WireProjection.projectThreadProjectionForWire(snapshot.projection),
    snapshotSequence: snapshot.snapshotSequence,
  })
  return { snapshotSequence: snapshot.snapshotSequence,
    ...ThreadStream.boundedSnapshotResponseFields({ bounded,
      compactTurnItems: options.compactTurnItems === true, dedupeBodies: options.dedupeBodies === true,
      compactIds: options.compactIds === true }) }
})
