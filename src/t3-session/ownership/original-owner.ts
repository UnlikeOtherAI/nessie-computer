import { CaptureFailure } from '../state/sqlite.js'
import type { RetainedOriginalOwnerPort } from './continuity.js'

/** The pinned source has no authenticated original-human/thread binding.
 * Keep that concrete refusal at the port used by capture and retained reads.
 *
 * This is a refusal implementation, NOT a qualified continuity producer. It
 * deliberately does not invoke supplied functions: an arbitrary physical
 * recheck, serialized admission or today's caller cannot establish ownership.
 * Replace this only when the canonical evidence producer and its live physical
 * recognizer have been integrated; do not add a callback that asserts trust.
 */
export const unprovenRetainedOriginalOwnerPort: RetainedOriginalOwnerPort = Object.freeze({
  async withReadScope() {
    throw new CaptureFailure('retained_original_owner_unproven')
  },
})
