import { randomUUID } from 'node:crypto'
import { CaptureFailure, requireCapture } from '../state/sqlite.js'
import type { T3CaptureJournal } from '../state/journal.js'
import type { NativeHistoryHomePort, RetainedOriginalOwnerPort, RetainedReadScope } from '../ownership/continuity.js'
import type { AdmittedT3SourcePort, ProvenT3Source, T3SourceManifest } from './manifest.js'
import { withT3SourceSnapshot } from './snapshot.js'
import { hydrateCapture, materializeSnapshot } from './materialize.js'
import type { OwnedCaptureWorkspacePort } from './materialize.js'

export interface RetainedCapturePorts {
  readonly source?: AdmittedT3SourcePort
  readonly originalOwner?: RetainedOriginalOwnerPort
  readonly workspace: OwnedCaptureWorkspacePort
  readonly journal: T3CaptureJournal
  readonly nativeHomes?: NativeHistoryHomePort
}

/** Machine-only passive capture. Local readiness is NOT a server claim, a human
 * read admission, native control or handoff. No lifecycle owner is constructed.
 */
export async function captureRetainedT3(ports: RetainedCapturePorts,
  manifest: T3SourceManifest, admittedRootKey: string) {
  const generation = randomUUID()
  let proven: ProvenT3Source | undefined
  let result: Awaited<ReturnType<typeof finishStage>> | undefined
  try {
    await withT3SourceSnapshot(ports.source, manifest, admittedRootKey, ports.originalOwner, generation,
      async (snapshot, reads) => {
      proven = snapshot.source
      const stage = await ports.workspace.createGeneration(generation)
      const priorGeneration = ports.journal.root(snapshot.source.physicalRootKey)?.last_ready_generation
      const prior = ports.journal.baseline(snapshot.source.physicalRootKey)
      ports.journal.begin(snapshot.source, generation, stage.reference)
      const fingerprint = snapshot.fingerprint(ports.journal.snapshotKey())
      requireCapture(!priorGeneration || prior, 'capture_requires_versioned_baseline')
      requireCapture(!prior || prior.layout === snapshot.source.layout, 'capture_source_layout_changed')
      requireCapture(snapshot.source.layout !== 'v2-80' || !prior || prior.legacy_digest === fingerprint.legacyDigest,
        'capture_frozen_legacy_diverged')
      await materializeSnapshot(snapshot, stage, reads)
      ports.journal.recordSnapshot(generation, fingerprint.digest, fingerprint.legacyDigest, snapshot.source.layout)
      return { source: snapshot.source, highWater: snapshot.sourceHighWater, reference: stage.reference }
    }, async (captured, reads, recheck) => {
      // The source transaction has committed; the physical and original-human
      // callback leases still cover hydration and final readiness rechecks.
      ports.journal.markCaptured(captured.source, generation, captured.highWater)
      result = await finishStage(ports, captured.source, generation, captured.reference, reads, recheck)
    })
    requireCapture(result, 'capture_completion_missing')
    ports.journal.requirePublished(result.source.physicalRootKey, generation)
    return result
  } catch (error) {
    const code = error instanceof CaptureFailure ? error.code : 'retained_capture_incomplete'
    if (proven) ports.journal.fail(proven, generation, code)
    else ports.journal.unavailable(admittedRootKey)
    throw new CaptureFailure(code)
  }
}

export async function resumeRetainedT3(ports: RetainedCapturePorts,
  manifest: T3SourceManifest, admittedRootKey: string, generation: string) {
  let result: Awaited<ReturnType<typeof finishStage>> | undefined
  let proven: ProvenT3Source | undefined
  try {
    await withT3SourceSnapshot(ports.source, manifest, admittedRootKey, ports.originalOwner, generation,
      async snapshot => {
      const source = snapshot.source
      proven = source
      const job = ports.journal.generation(generation)
      requireCapture(job && job.physical_root === source.physicalRootKey &&
        ports.journal.root(source.physicalRootKey)?.environment_id === source.environmentId,
      'capture_source_mismatch')
      requireCapture(job.phase === 'captured' || job.phase === 'ready', 'capture_requires_fresh_snapshot')
      requireCapture(typeof job.stage_ref === 'string', 'capture_stage_missing')
      requireCapture(snapshot.sourceHighWater === job.source_high_water, 'capture_source_advanced_requires_refresh')
      const prior = ports.journal.snapshot(generation)
      const fingerprint = snapshot.fingerprint(ports.journal.snapshotKey())
      requireCapture(prior && prior.layout === source.layout &&
        prior.digest === fingerprint.digest && prior.legacy_digest === fingerprint.legacyDigest,
      'capture_snapshot_changed_requires_refresh')
      ports.journal.recover(source, generation)
      ports.journal.requireCurrent(source.physicalRootKey, generation)
      return { source, reference: job.stage_ref }
    }, async (captured, reads, recheck) => {
      result = await finishStage(ports, captured.source, generation, captured.reference, reads, recheck)
    })
    requireCapture(result, 'capture_completion_missing')
    ports.journal.requirePublished(result.source.physicalRootKey, generation)
    return result
  } catch (error) {
    const code = error instanceof CaptureFailure ? error.code : 'retained_capture_incomplete'
    if (proven) ports.journal.fail(proven, generation, code)
    else ports.journal.unavailable(admittedRootKey)
    throw new CaptureFailure(code)
  }
}

async function finishStage(ports: RetainedCapturePorts, source: ProvenT3Source, generation: string,
  reference: string, reads: RetainedReadScope, recheckPhysicalSource: () => Promise<void>) {
  const stage = await ports.workspace.reopenGeneration(reference)
  requireCapture(stage.reference === reference, 'capture_stage_mismatch')
  const result = await hydrateCapture(stage, source, reads, ports.nativeHomes)
  await recheckPhysicalSource()
  await reads.recheckSource()
  // Serializes with capture advancement and retains known rows on rejection.
  // This is local data completion only; it grants no current human access.
  ports.journal.complete(source, generation, result.identities, result.aliases)
  const captured = ports.journal.generation(generation)
  const snapshot = ports.journal.snapshot(generation)
  requireCapture(captured && typeof captured.source_high_water === 'number', 'capture_watermark_missing')
  requireCapture(snapshot && typeof snapshot.digest === 'string', 'capture_snapshot_provenance_missing')
  return { generation, localState: 'ready' as const, nativeHomes: result.nativeHomes,
    source: { ...source }, watermark: { generation, sequence: captured.source_high_water },
    sourceSnapshot: { version: 1 as const, digest: snapshot.digest },
    serverCatalog: 'required_unbound' as const, ownerReadAdmission: 'required_unbound' as const,
    control: 'unavailable' as const }
}
