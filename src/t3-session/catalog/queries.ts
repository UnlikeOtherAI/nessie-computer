import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { ApplicationEvents, ProjectStore, ShellStream, ThreadStream, HistoryPaging, WireProjection,
  type ThreadReadService } from '@nessie/t3-session-source/engine'
import type { RetainedCatalogInput } from './operations.js'

type Reads = ThreadReadService['Service']

/** Original shell transaction, trims and tie rules; no scanner or timestamp cutoff. */
export const shellSnapshot = (reads: Reads, options: {
  readonly omitIdleSubagents: boolean; readonly omitOlderSettled: boolean
}) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projects = yield* ProjectStore.ProjectStoreV2
  const events = yield* ApplicationEvents.OrchestrationEventStore
  const { snapshot } = yield* ShellStream.loadSubscriberShellSnapshot({ sql,
    listShellIndex: reads.listActiveShellIndex(),
    readThreads: threadIds => reads.readShellSnapshot({ location: 'active',
      ...(threadIds === undefined ? {} : { threadIds }) }),
    listProjects: projects.listShells(), latestSequence: events.latestApplicationSequence, options })
  return snapshot
})

export const archivedSnapshot = (reads: Reads) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projects = yield* ProjectStore.ProjectStoreV2
  const events = yield* ApplicationEvents.OrchestrationEventStore
  const parts = yield* ShellStream.loadShellSnapshotParts({ sql,
    readThreads: reads.readShellSnapshot({ location: 'archive' }), listProjects: projects.listShells(),
    latestSequence: events.latestApplicationSequence })
  return { schemaVersion: parts.threads.schemaVersion, snapshotSequence: parts.snapshotSequence,
    projects: parts.projects, threads: parts.threads.archivedThreads }
})

export const familyRows = (reads: Reads, options: { readonly familyOf: RetainedCatalogInput<
  'orchestration.getThreadFamily'>['threadId'] } | { readonly worktreePath: string }) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* ApplicationEvents.OrchestrationEventStore
  const { threads, snapshotSequence } = yield* ShellStream.loadShellSnapshotParts({ sql,
    readThreads: reads.readShellSnapshot({ location: 'active', ...options }),
    listProjects: Effect.succeed([]), latestSequence: events.latestApplicationSequence })
  return { snapshotSequence, threads: threads.threads }
})

export const olderSettled = (reads: Reads,
  input: RetainedCatalogInput<'orchestration.getOlderSettledThreads'>) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* ApplicationEvents.OrchestrationEventStore
  return yield* ShellStream.loadOlderSettledThreadsPage({ sql, listThreads: reads.listOlderSettledThreads(input),
    readThreads: threadIds => reads.readShellSnapshot({ location: 'active', threadIds }),
    latestSequence: events.latestApplicationSequence })
})

export const boundedSnapshot = (reads: Reads, threadId: Parameters<Reads['getThreadSnapshotWindow']>[0],
  options: { readonly deferWork?: boolean; readonly compactTurnItems?: boolean;
    readonly dedupeBodies?: boolean; readonly compactIds?: boolean }) => Effect.gen(function* () {
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
