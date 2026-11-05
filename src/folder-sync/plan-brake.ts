import {
  FOLDER_SYNC_DELETE_BRAKE,
  FOLDER_SYNC_REPORT_LIMITS,
  type FolderSyncHeldDeletes,
} from '@nessie/executor-protocol'

import { stableId, type HeldDeleteDecision } from './reconcile-model.js'
import type { ArchiveCandidate } from './reconcile-entries.js'

/**
 * The mass-delete brake (plan §2.6, C23). Deletes made here become archives
 * in Nessie; one pass that would archive more than `max(10, 20 %)` of the
 * team's entries, or any pass while a whole space or team folder is missing,
 * holds every archive until a person confirms or restores the batch.
 * Downloads, uploads and every other action carry on.
 *
 * A held batch is named by its contents: the same held set keeps its id from
 * pass to pass, and a person's decision applies only to the batch they saw.
 */

export type BrakeContext = {
  /** Entries in the team: the base of the 20 %. */
  entryCount: number
  /** A whole folder is gone: hold whatever the count. */
  missing: 'team_folder_missing' | 'space_folder_missing' | null
  decision: HeldDeleteDecision | null
}

export type BrakeResult = {
  /** Archives that go ahead (released ones carry their batch id). */
  archives: ArchiveCandidate['action'][]
  /** Archives held for a person. */
  held: ArchiveCandidate[]
  /** Held archives the person chose to restore instead. */
  restore: ArchiveCandidate[]
  heldDeletes: FolderSyncHeldDeletes | null
}

/** The most archives one pass may make without asking. */
export const deleteBrakeLimit = (entryCount: number): number =>
  Math.max(FOLDER_SYNC_DELETE_BRAKE.min, FOLDER_SYNC_DELETE_BRAKE.fraction * entryCount)

/** The id of a held set: the same pages, the same id. */
export const heldBatchId = (candidates: readonly ArchiveCandidate[]): string =>
  stableId('held-deletes', ...candidates.map((candidate) => candidate.action.pageId).sort())

export const brakeDeletes = (candidates: readonly ArchiveCandidate[], context: BrakeContext): BrakeResult => {
  if (candidates.length === 0) return { archives: [], held: [], restore: [], heldDeletes: null }
  const affected = candidates.reduce((sum, candidate) => sum + candidate.affected, 0)
  const reason = context.missing ?? (affected > deleteBrakeLimit(context.entryCount) ? 'mass_delete' : null)
  if (reason === null) {
    return { archives: candidates.map((candidate) => candidate.action), held: [], restore: [], heldDeletes: null }
  }
  const batchId = heldBatchId(candidates)
  if (context.decision?.batchId === batchId) {
    if (context.decision.decision === 'confirm') {
      return {
        archives: candidates.map((candidate) => ({ ...candidate.action, heldDeleteBatchId: batchId })),
        held: [],
        restore: [],
        heldDeletes: null,
      }
    }
    return { archives: [], held: [], restore: [...candidates], heldDeletes: null }
  }
  return {
    archives: [],
    held: [...candidates],
    restore: [],
    heldDeletes: {
      batchId,
      count: candidates.length,
      sample: candidates
        .map((candidate) => candidate.action.relPath)
        .sort()
        .slice(0, FOLDER_SYNC_REPORT_LIMITS.heldDeleteSample),
      reason,
    },
  }
}
