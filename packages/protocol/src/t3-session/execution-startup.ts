import { z } from 'zod'
import { T3ExecutionCustodySchema } from './native-execution.js'

/** Sent directly through SYSTEM-created graph stdin, never a daemon-selected path.
 * creatorKey is a per-process private channel secret; never log or publish this frame.
 */
export const T3ProtectedGraphStartupSchema = z.object({
  version: z.literal(1), type: z.literal('t3.graph.start'), executorId: z.string().min(1).max(512),
  stateDirectory: z.string().min(1).max(32768), custody: T3ExecutionCustodySchema,
  graphId: z.string().regex(/^[a-f0-9]{64}$/u), creatorKey: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
export type T3ProtectedGraphStartup = z.infer<typeof T3ProtectedGraphStartupSchema>
export const T3ProtectedCompanionRoleSchema = z.enum(['resource', 'execution-offer', 'execution-enroll',
  'execution-graph', 'execution-reserve', 'execution-prepare', 'execution-associate'])
export type T3ProtectedCompanionRole = z.infer<typeof T3ProtectedCompanionRoleSchema>
