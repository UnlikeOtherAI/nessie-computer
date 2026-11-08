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
      ports.journal.begin(snapshot.source, generation, stage.reference)
      await materializeSnapshot(snapshot, stage, reads)
      return { source: snapshot.source, highWater: snapshot.sourceHighWater, reference: stage.reference }
    }, async (captured, reads, recheck) => {
      // The source transaction has committed; the physical and original-human
      // callback leases still cover hydration and final readiness rechecks.
      ports.journal.markCaptured(captured.source, generation, captured.highWater)
      result = await finishStage(ports, captured.source, generation, captured.reference, reads, recheck)
    })
    requireCapture(result, 'capture_completion_missing')
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
      ports.journal.recover(source, generation)
      ports.journal.requireCurrent(source.physicalRootKey, generation)
      return { source, reference: job.stage_ref }
    }, async (captured, reads, recheck) => {
      result = await finishStage(ports, captured.source, generation, captured.reference, reads, recheck)
    })
    requireCapture(result, 'capture_completion_missing')
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
  return { generation, localState: 'ready' as const, nativeHomes: result.nativeHomes,
    serverCatalog: 'required_unbound' as const, ownerReadAdmission: 'required_unbound' as const,
    control: 'unavailable' as const }
}
