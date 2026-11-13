import { z } from 'zod'
import { T3_SOURCE_COMMIT } from './routing.js'

const reference = z.string().min(1).max(512)
const hex = z.string().regex(/^[a-f0-9]{64}$/u)
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
/** Actual held source/writer availability only. No retained read or effect readiness. */
export const T3InspectionRuntimeAnnouncementSchema = z.object({
  role: z.literal('source-inspection'), environmentId: reference, runtimeGeneration: reference,
  sourceRevision: z.literal(T3_SOURCE_COMMIT), physicalRootKey: reference, captureGeneration: reference,
}).strict()
export type T3InspectionRuntimeAnnouncement = z.infer<typeof T3InspectionRuntimeAnnouncementSchema>

/** Backend-accepted graph lifetime, for bounded local retention only. This is
 * never an admission, launch grant, native signature or capability announcement.
 */
export const T3LaneInspectionAcceptedSchema = z.object({
  inspectionId: hex, graphId: hex, expiresAt: z.string().datetime(), receiptDigest: sha,
  executorId: z.string().uuid(), environmentId: reference,
  connectionEpoch: z.string().regex(/^(0|[1-9][0-9]*)$/u), runtimeGeneration: reference,
  sourceRevision: z.literal(T3_SOURCE_COMMIT), physicalRootKey: reference, captureGeneration: reference,
  correlationId: reference, commandId: reference, requestSha256: sha,
  relayHmac: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u),
}).strict()
export type T3LaneInspectionAccepted = z.infer<typeof T3LaneInspectionAcceptedSchema>
