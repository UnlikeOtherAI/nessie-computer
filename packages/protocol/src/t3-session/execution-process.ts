import { z } from 'zod'

const text = z.string().max(32768).refine(value => !value.includes('\0'))
const path = z.string().min(1).max(32768).refine(value => !value.includes('\0'))
export const T3ExecutionHistoryInvocationSchema = z.object({
  method: z.enum(['getSessionMessages', 'forkSession']), sessionId: path, rawOptions: text,
}).strict()
export type T3ExecutionHistoryInvocation = z.infer<typeof T3ExecutionHistoryInvocationSchema>
const launch = z.object({ command: path, args: z.array(text).max(256), cwd: path,
  environment: z.record(z.string().min(1).max(512).refine(value => !/[=\0]/u.test(value)), text),
}).strict()
/** The service holds these bytes after the protected original adapter prepares
 * its process. A launch caller submits only the signed backend phase. */
export const T3ExecutionProcessLaunchSchema = z.discriminatedUnion('processPurpose', [
  launch.extend({ processPurpose: z.literal('provider') }),
  launch.extend({ processPurpose: z.literal('claude-history-read'),
    history: T3ExecutionHistoryInvocationSchema.extend({ method: z.literal('getSessionMessages') }) }),
  launch.extend({ processPurpose: z.literal('claude-history-fork'),
    history: T3ExecutionHistoryInvocationSchema.extend({ method: z.literal('forkSession') }) }),
])
export type T3ExecutionProcessLaunch = z.infer<typeof T3ExecutionProcessLaunchSchema>
