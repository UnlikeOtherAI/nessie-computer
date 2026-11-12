import { z } from 'zod'
import { ExecutorInferenceSourceSchema } from './personal-inference-authority.js'

const identifier = z.string().min(1).max(200)
const status = z.enum(['completed', 'in_progress', 'incomplete']).optional()
/** Stateless Responses state stays provider-owned, never visible reasoning text. */
export const ResponsesReplayItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reasoning'), id: identifier,
    encrypted_content: z.string().min(1).max(256 * 1024),
    summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string().max(512 * 1024) }).strict())
      .max(128).optional(),
    status,
  }).strict(),
  z.object({ type: z.literal('function_call'), id: identifier, call_id: identifier,
    name: identifier, namespace: identifier.optional(), arguments: z.string().max(16 * 1024), status,
  }).strict(),
  z.object({ type: z.literal('message'), id: identifier, role: z.literal('assistant'),
    phase: z.enum(['commentary', 'final_answer']).nullable().optional(),
    content: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('output_text'), text: z.string().max(512 * 1024),
        annotations: z.array(z.unknown()).max(0).optional(), logprobs: z.array(z.unknown()).max(0).optional(),
      }).strict(),
      z.object({ type: z.literal('refusal'), refusal: z.string().max(512 * 1024) }).strict(),
    ])).max(128), status,
  }).strict(),
])
export type ResponsesReplayItem = z.infer<typeof ResponsesReplayItemSchema>
export const ResponsesReplayItemsSchema = z.array(ResponsesReplayItemSchema).max(256)

export const ResponsesContinuationSchema = z.object({
  version: z.literal(1),
  inferenceSource: ExecutorInferenceSourceSchema.options[1],
  providerModelId: identifier,
  /** Established by the signed private authority, never by caller metadata. */
  rootRunId: identifier,
  outputItemsJson: z.string().min(2).max(256 * 1024).superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength > 256 * 1024) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Responses continuation exceeds its byte bound' })
      return
    }
    try {
      if (!ResponsesReplayItemsSchema.safeParse(JSON.parse(value)).success) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Responses continuation items' })
      }
    } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Responses continuation encoding' }) }
  }),
}).strict()
export type ResponsesContinuation = z.infer<typeof ResponsesContinuationSchema>
