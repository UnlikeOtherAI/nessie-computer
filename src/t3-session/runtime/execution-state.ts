import { randomUUID } from 'node:crypto'
import * as Effect from 'effect/Effect'
import { materializeSnapshot, type OwnedCaptureStage } from '../import/materialize.js'
import { withSourceSnapshotView } from '../import/snapshot-view.js'
import type { ProvenT3Source } from '../import/manifest.js'
import { recognizeT3ExecutionResource, type T3ExecutionResourceScope } from '../source/execution.js'
import { CaptureFailure, requireCapture } from '../state/sqlite.js'
import { withOwnedSnapshotWorkspace } from './capture-workspace.js'
import { SessionStateOwner } from './state-owner.js'
import { SessionStateError } from './paths.js'

export interface HeldSessionExecutionState {
  readonly source: ProvenT3Source
  readonly stage: OwnedCaptureStage
  readonly captureGeneration: string
  readonly sourceHighWater: number
  readonly owner: SessionStateOwner['Service']
  readonly signal: AbortSignal
  recheck(): Promise<void>
}

/** Import only inside the protected producer's already-pinned snapshot. There
 * is no retained grant, second source connection or nested source BEGIN here.
 * The destination remains distinct from passive captures for its entire life.
 * Callers must drain their original graph scope before this callback returns.
 * A captured destination is NOT executing readiness or provider authority. */
export async function withSessionExecutionState<A>(source: T3ExecutionResourceScope, storageRoot: string,
  use: (state: HeldSessionExecutionState) => Promise<A>, callerSignal: AbortSignal): Promise<A> {
  const receipt = await recognizeT3ExecutionResource(source)
  const signal = AbortSignal.any([source.signal, callerSignal])
  signal.throwIfAborted()
  return withOwnedSnapshotWorkspace(storageRoot, receipt.evidence.source.physicalRootKey, 'execution-state',
    async storage => {
      let active = true
      const assertCurrent = () => {
        requireCapture(active, 'execution_state_scope_closed')
        storage.assertCurrent()
      }
      const recheck = async () => {
        assertCurrent()
        const current = await recognizeT3ExecutionResource(source)
        requireCapture(current === receipt, 'execution_state_source_replaced')
        assertCurrent()
      }
      const journal = storage.journal
      const rootKey = receipt.evidence.source.physicalRootKey
      const attempt = journal.attempts.observe(receipt.evidence.source.admittedRootKey)
      try {
        await recheck()
        const imported = await source.withReadonlySourceSnapshot(async snapshot => {
          await snapshot.recheck()
          assertCurrent()
          requireCapture(snapshot.resourceGeneration === receipt.resourceGeneration
            && snapshot.source.physicalRootKey === rootKey
            && snapshot.source.admittedRootKey === receipt.evidence.source.admittedRootKey
            && snapshot.source.environmentId === receipt.evidence.source.environmentId,
          'execution_snapshot_source_mismatch')
          return withSourceSnapshotView(snapshot.database, snapshot.source, snapshot.sourceHighWater,
            assertCurrent, async view => {
              const fingerprint = view.fingerprint(journal.snapshotKey())
              const root = journal.root(rootKey)
              const baseline = journal.baseline(rootKey)
              const previous = root && typeof root.generation === 'string' ? journal.generation(root.generation) : undefined
              requireCapture(!root || previous?.phase === 'capturing' || previous?.phase === 'captured',
                'execution_state_phase_unknown')
              const resume = previous?.phase === 'captured'
              requireCapture(!resume || baseline, 'execution_state_baseline_missing')
              requireCapture(!baseline || baseline.layout === snapshot.source.layout, 'capture_source_layout_changed')
              requireCapture(snapshot.source.layout !== 'v2-80' || !baseline
                || baseline.legacy_digest === fingerprint.legacyDigest, 'capture_frozen_legacy_diverged')
              let generation: string
              let stage: OwnedCaptureStage
              if (root && resume) {
                // Never replace accepted engine writes with another source copy.
                // Changed sources need an explicit reconciliation implementation.
                requireCapture(typeof root.generation === 'string', 'execution_state_generation_missing')
                generation = root.generation
                const job = journal.generation(generation)
                const prior = journal.snapshot(generation)
                requireCapture(job?.phase === 'captured' && typeof job.stage_ref === 'string'
                  && job.source_high_water === snapshot.sourceHighWater && prior
                  && prior.digest === fingerprint.digest && prior.legacy_digest === fingerprint.legacyDigest,
                'execution_state_source_changed_or_incomplete')
                journal.recover(snapshot.source, generation, attempt)
                stage = await storage.workspace.reopenGeneration(job.stage_ref)
              } else {
                // A capturing generation was never exposed to the original
                // engine. Retry a failed copy into a fresh stage, retaining its
                // journal/artifact rather than deleting or resetting evidence.
                if (root && typeof root.generation === 'string') {
                  journal.fail(snapshot.source, root.generation, 'execution_copy_interrupted')
                }
                generation = randomUUID()
                stage = await storage.workspace.createGeneration(generation)
                journal.begin(snapshot.source, generation, stage.reference, attempt)
                // Source linkage version 2 authorizes the protected local copy,
                // not historical-human continuity or a remote caller's read.
                const checkRead = async () => { await snapshot.recheck(); assertCurrent() }
                await materializeSnapshot(view, stage, { recheckSource: checkRead, recheckThread: checkRead })
                await checkRead()
                journal.recordSnapshot(generation, fingerprint.digest, fingerprint.legacyDigest, snapshot.source.layout)
              }
              await snapshot.recheck()
              assertCurrent()
              return { source: snapshot.source, stage, captureGeneration: generation,
                sourceHighWater: snapshot.sourceHighWater }
            })
        })
        // Only after the producer has committed its source read transaction.
        await recheck()
        journal.markCaptured(imported.source, imported.captureGeneration, imported.sourceHighWater)
        const owner = SessionStateOwner.of({ runtimeGeneration: storage.runtimeGeneration,
          assertCurrent: Effect.try({ try: assertCurrent,
            catch: () => new SessionStateError('session_state_ownership_lost') }) })
        const result = await use(Object.freeze({ ...imported, owner, signal: storage.signal, recheck }))
        await recheck()
        journal.attempts.succeed(attempt)
        return result
      } catch (error) {
        const code = error instanceof CaptureFailure ? error.code : 'execution_state_incomplete'
        journal.attempts.fail(attempt, code)
        throw new CaptureFailure(code)
      } finally { active = false }
    }, signal)
}
