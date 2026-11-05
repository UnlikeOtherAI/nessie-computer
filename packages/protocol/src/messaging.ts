import { z } from 'zod'

import { AgentIdSchema, UserIdSchema } from './ids.js'

/**
 * Hard upper bound on the length of a single chat message body. Anything
 * larger should be sent as a file attachment instead of inline text —
 * pasted documents blow up orchestrator LLM context, cost, and latency,
 * and they make the conversation unreadable.
 */
export const CHAT_MESSAGE_MAX_CHARS = 4000

/**
 * How many attachments a single chat message may carry. The composer stages
 * uploads client-side and the message-create body caps the linked ids, so the
 * same number bounds both sides.
 */
export const MESSAGE_ATTACHMENT_LIMIT = 10

/**
 * Per-file ceiling for chat/avatar uploads (`POST /api/uploads`). Larger files
 * belong in the knowledge base, which uses the (much larger) configured
 * `NESSIE_MAX_UPLOAD_BYTES`. The composer pre-checks against this value; the
 * server's 413 stays the source of truth.
 */
export const MESSAGE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

/**
 * `metadata.authorship` on a message a signed-in person typed into a client's
 * composer and sent themselves. It is an allowlist marker, not an exclusion
 * list: only `createThreadMessage` writes it, and only when its caller is a
 * composer route. A relayed post (`delegatedByAgentId`), a workflow send,
 * inbound mail, an integration, a trigger fire, a card press, a voice
 * hand-off and every server-authored row never carry it, and the server
 * strips a copy that arrives any other way. An executor conversation lease
 * carries only on messages that hold it.
 */
export const PERSON_MESSAGE_AUTHORSHIP = 'person' as const

export const isPersonAuthoredMessageMetadata = (metadata: unknown): boolean =>
  typeof metadata === 'object'
  && metadata !== null
  && !Array.isArray(metadata)
  && (metadata as Record<string, unknown>).authorship === PERSON_MESSAGE_AUTHORSHIP

/**
 * `metadata.postedByRunId` on a message a run wrote into its own conversation:
 * the run that posted it, so the run's thought process stays reachable from
 * the message after the run has ended. Only the worker's message chokepoint
 * writes it (`createAgentMessage`), and only for a post into the run's own
 * thread, because the thought log is read through that thread
 * (`GET /api/threads/:threadId/runs/:runId/thinking`). A message no run wrote,
 * one written before the key existed and a run's post into another
 * conversation never carry it; an older reader ignores it as an unknown key.
 */
export const POSTED_BY_RUN_METADATA_KEY = 'postedByRunId' as const

export const readPostedByRunId = (metadata: unknown): string | null => {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, unknown>)[POSTED_BY_RUN_METADATA_KEY]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The identity selected by an agent @mention in a composer.
 *
 * Ordinary agents are addressed by `agentId`. A Personal Assistant presence
 * additionally carries its owner because several presences share one Agent
 * row inside a channel. Display text is deliberately absent: names render for
 * people, but they are not an address and need not be unique.
 */
export const AgentMentionSchema = z.object({
  type: z.literal('agent'),
  agentId: AgentIdSchema,
  principalUserId: UserIdSchema.optional(),
})
export type AgentMention = z.infer<typeof AgentMentionSchema>
