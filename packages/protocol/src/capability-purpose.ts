import { z } from 'zod'

/** Maintainer-authored catalogue data. It describes outcomes; it grants nothing. */
export const CapabilityPurposeDescriptorSchema = z.object({
  version: z.literal(1),
  catalogueRevision: z.string().min(1).max(128),
  status: z.enum(['candidate', 'validated']),
  outcomes: z.array(z.string().min(1).max(300)).min(1).max(8),
  objectsAndActions: z.array(z.string().min(1).max(300)).max(12),
  entryReads: z.array(z.string().min(1).max(128)).max(8),
  limits: z.array(z.string().min(1).max(300)).max(8),
  compositions: z.array(z.string().min(1).max(300)).max(6),
}).strict()
export type CapabilityPurposeDescriptor = z.infer<typeof CapabilityPurposeDescriptorSchema>
