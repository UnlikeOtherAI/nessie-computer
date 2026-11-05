import { z } from 'zod'

export const ExecutorListQuerySchema = z.object({ projectId: z.string().uuid().optional() }).strict()

export const ExecutorSharingChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), userId: z.string().uuid(), role: z.enum(['use', 'admin']).nullable() }).strict(),
  z.object({ kind: z.literal('project'), projectId: z.string().uuid(), enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal('team'), enabled: z.boolean() }).strict(),
])
export type ExecutorSharingChange = z.infer<typeof ExecutorSharingChangeSchema>

export const ExecutorSharingUpdateSchema = z.object({
  teamId: z.string().uuid(), change: ExecutorSharingChangeSchema,
}).strict()

/** A computer's name as Nessie shows it; only someone who manages the computer may change it. */
export const ExecutorRenameSchema = z.object({ label: z.string().trim().min(1).max(120) }).strict()
export type ExecutorRename = z.infer<typeof ExecutorRenameSchema>

export const ExecutorSharingViewSchema = z.object({
  executorId: z.string().uuid(),
  teamId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  everyone: z.boolean(),
  people: z.array(z.object({ userId: z.string().uuid(), name: z.string().nullable(), role: z.enum(['use', 'admin']) }).strict()),
  projects: z.array(z.object({ projectId: z.string().uuid(), name: z.string() }).strict()),
  availablePeople: z.array(z.object({ userId: z.string().uuid(), name: z.string().nullable() }).strict()),
  availableProjects: z.array(z.object({ projectId: z.string().uuid(), name: z.string() }).strict()),
}).strict()
export type ExecutorSharingView = z.infer<typeof ExecutorSharingViewSchema>

/**
 * How the person reading a computers list reaches each computer, decided by
 * the server from the same facts its visibility predicate reads. Only the
 * pairing owner's name is ever disclosed, and only to someone that owner
 * named; a project the reader may not open has no name here.
 */
export const ExecutorViewerAccessSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner') }).strict(),
  z.object({
    kind: z.literal('person'),
    owner: z.object({ userId: z.string().uuid(), name: z.string().nullable() }).strict(),
  }).strict(),
  z.object({ kind: z.literal('team') }).strict(),
  z.object({
    kind: z.literal('project'),
    projects: z.array(z.object({ projectId: z.string().uuid(), name: z.string().nullable() }).strict()),
  }).strict(),
])
export type ExecutorViewerAccess = z.infer<typeof ExecutorViewerAccessSchema>
