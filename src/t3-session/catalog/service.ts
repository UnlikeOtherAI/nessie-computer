import * as Effect from 'effect/Effect'
import { EnvironmentIdentity, HistoryPaging, WireProjection,
  SourceContracts as S } from '@nessie/t3-session-source/engine'
import { ExecutorT3HttpEndpoints, type ExecutorT3ImplementationSlots } from '@nessie/executor-protocol/t3-session'
import type { RetainedCapturePorts } from '../import/capture.js'
import { readRetainedEffect, type RetainedCatalogSource } from './scope.js'
import type { RetainedCatalogInput } from './operations.js'
import { archivedSnapshot, boundedSnapshot, familyRows, olderSettled, shellSnapshot } from './queries.js'

type HttpEndpoint<K extends keyof typeof ExecutorT3HttpEndpoints> = typeof ExecutorT3HttpEndpoints[K]
export type RetainedHttpInput<K extends keyof typeof ExecutorT3HttpEndpoints> = {
  readonly params: HttpEndpoint<K>['~Params']['Type']
  readonly query: HttpEndpoint<K>['~Query']['Type']
}

/** Production read composition, with REQUIRED producer inputs. Construction starts
 * no writer, provider, server, stream or native process. Returned envelopes retain
 * capture provenance separately from original T3 values and their sequence numbers.
 */
export function createRetainedCatalogService(ports: RetainedCapturePorts, boundSource: RetainedCatalogSource) {
  const source = { ...boundSource, authorization: 'catalog' as const }
  const shellError = () => new S.OrchestrationV2GetShellSnapshotError({ message: 'Retained shell read failed' })
  const projectionError = (threadId: S.ThreadId) =>
    new S.OrchestrationV2GetThreadProjectionError({ threadId, message: 'Retained thread read failed' })
  const rpc = {
    'orchestration.getArchivedShellSnapshot': (
      _input: RetainedCatalogInput<'orchestration.getArchivedShellSnapshot'>,
    ) =>
      readRetainedEffect(ports, source, 'catalog', (reads, selection) => archivedSnapshot(reads, selection)
        .pipe(Effect.mapError(shellError))),
    'orchestration.getThreadFamily': (input: RetainedCatalogInput<'orchestration.getThreadFamily'>) =>
      readRetainedEffect(ports, source, 'catalog', (reads, selection) =>
        familyRows(reads, { familyOf: input.threadId }, selection)
        .pipe(Effect.mapError(shellError))),
    'orchestration.getOlderSettledThreads': (input: RetainedCatalogInput<'orchestration.getOlderSettledThreads'>) =>
      readRetainedEffect(ports, source, 'catalog', (reads, selection) => olderSettled(reads, input, selection)
        .pipe(Effect.mapError(shellError))),
    'orchestration.getThreadTitles': (input: RetainedCatalogInput<'orchestration.getThreadTitles'>) =>
      readRetainedEffect(ports, source, input.threadIds, reads => reads.getThreadTitles(input.threadIds)
        .pipe(Effect.mapError(shellError))),
    'orchestration.getWorktreeThreadIds': (input: RetainedCatalogInput<'orchestration.getWorktreeThreadIds'>) =>
      readRetainedEffect(ports, source, 'catalog', (reads, selection) =>
        familyRows(reads, { worktreePath: input.worktreePath }, selection)
        .pipe(Effect.map(result => ({ threadIds: result.threads.map(thread => thread.id) })),
          Effect.mapError(shellError))),
    'orchestration.getThreadProjection': (input: RetainedCatalogInput<'orchestration.getThreadProjection'>) =>
      readRetainedEffect(ports, source, [input.threadId], reads => reads.getThreadSnapshotWindow(input.threadId,
        { rowLimit: HistoryPaging.THREAD_HISTORY_SNAPSHOT_ROW_LIMIT }).pipe(
        Effect.map(snapshot => HistoryPaging.buildBoundedThreadProjection({
          projection: WireProjection.projectThreadProjectionForWire(snapshot.projection),
          snapshotSequence: snapshot.snapshotSequence }).projection),
        Effect.mapError(() => projectionError(input.threadId)))),
    'orchestration.getTurnItem': (input: RetainedCatalogInput<'orchestration.getTurnItem'>) =>
      readRetainedEffect(ports, source, [input.threadId], reads => reads.getTurnItem(input)
        .pipe(Effect.mapError(() => projectionError(input.threadId)))),
    'orchestration.searchThread': (input: RetainedCatalogInput<'orchestration.searchThread'>) =>
      readRetainedEffect(ports, source, [input.threadId], reads => reads.searchThread(input)
        .pipe(Effect.mapError(() => new S.OrchestrationV2SearchThreadError({ cause: 'retained_search_failed' })))),
  }
  const http = {
    shellSnapshot: (input: RetainedHttpInput<'shellSnapshot'>) =>
      readRetainedEffect(ports, source, 'catalog', (reads, selection) => shellSnapshot(reads, {
        omitIdleSubagents: input.query.omitIdleSubagents === '1',
        omitOlderSettled: input.query.omitOlderSettled === '1',
      }, selection)),
    threadSnapshot: (input: RetainedHttpInput<'threadSnapshot'>) =>
      readRetainedEffect(ports, source, [input.params.threadId], reads => reads.getThreadSnapshot(input.params.threadId)
        .pipe(Effect.map(snapshot => ({ snapshotSequence: snapshot.snapshotSequence,
          projection: WireProjection.projectThreadProjectionForWire(snapshot.projection) })))),
    threadTranscript: (input: RetainedHttpInput<'threadTranscript'>) =>
      readRetainedEffect(ports, source, [input.params.threadId], reads =>
        reads.getThreadTranscript(input.params.threadId)
        .pipe(Effect.provideService(EnvironmentIdentity.ServerEnvironmentIdentity,
          { getEnvironmentId: Effect.succeed(source.environmentId) }))),
    threadBoundedSnapshot: (input: RetainedHttpInput<'threadBoundedSnapshot'>) =>
      readRetainedEffect(ports, source, [input.params.threadId], reads =>
        boundedSnapshot(reads, input.params.threadId, {
        deferWork: input.query.deferWork === '1', compactTurnItems: input.query.compactTurnItems === '1',
        dedupeBodies: input.query.dedupeBodies === '1', compactIds: input.query.compactIds === '1',
      })),
    threadHistoryPage: (input: RetainedHttpInput<'threadHistoryPage'>) =>
      readRetainedEffect(ports, source, [input.params.threadId], reads =>
        reads.getThreadHistoryPage(input.params.threadId,
        input.query.cursor, input.query.throughEntryId, input.query.view === 'conversation',
        input.query.view === 'work' ? 'work' : input.query.deferWork === '1' ? 'deferred' : undefined).pipe(
        Effect.map(page => input.query.compactIds === '1' ? { ...page, idTable: true as const } : page))),
  }
  return { rpc, http }
}

export type RetainedCatalogService = ReturnType<typeof createRetainedCatalogService>

/** The existing typed dispatcher seam. The outer broker must carry the bound
 * source/capture metadata, admit its request, and classify lease defects as
 * transport failures. No stream or mutating slot is installed by passive reads.
 */
export function retainedCatalogSlots(service: RetainedCatalogService) {
  const slots = {
    'orchestration.getArchivedShellSnapshot': (input: RetainedCatalogInput<'orchestration.getArchivedShellSnapshot'>) =>
      service.rpc['orchestration.getArchivedShellSnapshot'](input).pipe(Effect.map(result => result.value)),
    'orchestration.getThreadFamily': (input: RetainedCatalogInput<'orchestration.getThreadFamily'>) =>
      service.rpc['orchestration.getThreadFamily'](input).pipe(Effect.map(result => result.value)),
    'orchestration.getOlderSettledThreads': (input: RetainedCatalogInput<'orchestration.getOlderSettledThreads'>) =>
      service.rpc['orchestration.getOlderSettledThreads'](input).pipe(Effect.map(result => result.value)),
    'orchestration.getThreadTitles': (input: RetainedCatalogInput<'orchestration.getThreadTitles'>) =>
      service.rpc['orchestration.getThreadTitles'](input).pipe(Effect.map(result => result.value)),
    'orchestration.getWorktreeThreadIds': (input: RetainedCatalogInput<'orchestration.getWorktreeThreadIds'>) =>
      service.rpc['orchestration.getWorktreeThreadIds'](input).pipe(Effect.map(result => result.value)),
    'orchestration.getThreadProjection': (input: RetainedCatalogInput<'orchestration.getThreadProjection'>) =>
      service.rpc['orchestration.getThreadProjection'](input).pipe(Effect.map(result => result.value)),
    'orchestration.getTurnItem': (input: RetainedCatalogInput<'orchestration.getTurnItem'>) =>
      service.rpc['orchestration.getTurnItem'](input).pipe(Effect.map(result => result.value)),
    'orchestration.searchThread': (input: RetainedCatalogInput<'orchestration.searchThread'>) =>
      service.rpc['orchestration.searchThread'](input).pipe(Effect.map(result => result.value)),
  } satisfies ExecutorT3ImplementationSlots
  return slots
}
