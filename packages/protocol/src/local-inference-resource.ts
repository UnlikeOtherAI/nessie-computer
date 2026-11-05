import { z } from 'zod'
import { ExecutorInferenceSourceSchema } from './personal-inference-authority.js'

export const LocalInferenceResourceControlSchema = z.object({
  inferenceSource: ExecutorInferenceSourceSchema.optional(),
  capacity: z.number().int().min(1).max(16),
  controlRevision: z.number().int().positive(),
  healthReason: z.enum(['termination_uncertain']).nullable(),
  paused: z.boolean(),
  resourceId: z.string().uuid(),
}).strict()
export type LocalInferenceResourceControl = z.infer<typeof LocalInferenceResourceControlSchema>

export const LocalInferenceResourceAttachmentSchema = z.object({
  inferenceSource: ExecutorInferenceSourceSchema.optional(),
  connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/),
  hostId: z.string().uuid(),
  organizationId: z.string().uuid(),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{50,200}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{64,128}$/),
}).strict()
export type LocalInferenceResourceAttachment = z.infer<typeof LocalInferenceResourceAttachmentSchema>

export const LocalInferenceResourceAdmissionSchema = z.object({
  inferenceSource: ExecutorInferenceSourceSchema.optional(),
  admissionId: z.string().uuid(),
  fence: z.string().uuid(),
  resourceId: z.string().uuid(),
}).strict()
export type LocalInferenceResourceAdmission = z.infer<typeof LocalInferenceResourceAdmissionSchema>

export const LocalInferenceTerminationSchema = LocalInferenceResourceAdmissionSchema.extend({
  attemptId: z.string().uuid(),
  confirmed: z.boolean(),
}).strict()
export type LocalInferenceTermination = z.infer<typeof LocalInferenceTerminationSchema>
