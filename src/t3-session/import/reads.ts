import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { createSessionStateLayers, createSessionReadLayers, ThreadReadService,
  SourceContracts as S } from '@nessie/t3-session-source/engine'
import { requireCapture } from '../state/sqlite.js'
import type { RetainedReadScope } from '../ownership/continuity.js'
import type { RetainedCapturePorts } from './capture.js'
import type { T3SourceManifest } from './manifest.js'

/** One guarded page per callback lifetime. This is not a gateway, credential,
 * live stream, original-owner producer or alternate history implementation.
 */
async function readPage<A>(ports: RetainedCapturePorts, manifest: T3SourceManifest, admittedRootKey: string,
  generation: string, threadId: S.ThreadId,
  read: (service: ThreadReadService['Service'], lease: RetainedReadScope) => Effect.Effect<A, unknown>) {
  const sourcePort = ports.source
  const originalOwner = ports.originalOwner
  requireCapture(sourcePort && originalOwner, 'required_retained_read_producers')
  requireCapture(manifest.homes.some(home => home.admittedRootKey === admittedRootKey), 'source_not_in_manifest')
  return sourcePort.withReadonlySource(manifest, admittedRootKey, async (source, _database, recheck) =>
    originalOwner.withReadScope({ source, physicalSourceRecheck: recheck,
      captureGeneration: generation, purpose: 'retained-history-read' }, async lease => {
      await recheck()
      await lease.recheckSource()
      await lease.recheckThread(threadId)
      const job = ports.journal.generation(generation)
      requireCapture(job?.phase === 'ready' && job.physical_root === source.physicalRootKey && typeof job.stage_ref === 'string',
        'capture_history_not_ready')
      const root = ports.journal.root(source.physicalRootKey)
      requireCapture(root?.environment_id === source.environmentId && root.conflict === 0, 'capture_history_source_conflict')
      const identity = ports.journal.catalog(source.physicalRootKey).find(row => row.thread_id === threadId)
      requireCapture(identity && identity.source_state !== 'deleted', 'capture_history_tombstoned_or_unknown')
      const stage = await ports.workspace.reopenGeneration(job.stage_ref)
      requireCapture(stage.reference === job.stage_ref, 'capture_stage_mismatch')
      const state = createSessionStateLayers()
      const reads = createSessionReadLayers(state)
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        return yield* read(yield* ThreadReadService, lease)
      }).pipe(Effect.provide(reads.layer.pipe(Layer.provideMerge(stage.sql))))))
      await lease.recheckThread(threadId)
      await lease.recheckSource()
      await recheck()
      // A concurrent refresh/conflict cannot publish through an obsolete page.
      const latest = ports.journal.root(source.physicalRootKey)
      requireCapture(latest?.generation === root.generation && latest?.conflict === 0, 'capture_history_generation_changed')
      return result
    }))
}

export function readRetainedProjection(ports: RetainedCapturePorts, manifest: T3SourceManifest,
  admittedRootKey: string, generation: string, threadId: S.ThreadId) {
  return readPage(ports, manifest, admittedRootKey, generation, threadId,
    service => service.getThreadProjection(threadId))
}

export function readRetainedHistoryPage(ports: RetainedCapturePorts, manifest: T3SourceManifest,
  admittedRootKey: string, generation: string,
  ...input: Parameters<ThreadReadService['Service']['getThreadHistoryPage']>) {
  return readPage(ports, manifest, admittedRootKey, generation, input[0],
    service => service.getThreadHistoryPage(...input))
}

export function readRetainedSnapshotWindow(ports: RetainedCapturePorts, manifest: T3SourceManifest,
  admittedRootKey: string, generation: string,
  ...input: Parameters<ThreadReadService['Service']['getThreadSnapshotWindow']>) {
  return readPage(ports, manifest, admittedRootKey, generation, input[0],
    service => service.getThreadSnapshotWindow(...input))
}
