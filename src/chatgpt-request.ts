import { createHash } from 'node:crypto'
import { mapMessagesToResponses, mapToolsToResponses } from '@nessie/executor-support/responses-input'
import type { LocalInferenceAttemptRequest, ToolSchemaDescriptor } from '@nessie/executor-protocol'
import type { ChatgptModel } from './chatgpt-models.js'
import { ChatgptError } from './chatgpt-errors.js'
import { chatgptAuthorityRoot, replayChatgptContinuation } from './chatgpt-continuation.js'

export const CHATGPT_TOOL_NAMESPACE = 'nessie'
// The documented function-name bound is 64 characters; keep the full hash.
export const chatgptFunctionName = (name: string): string => createHash('sha256').update(name).digest('hex')

export const chatgptToolNames = (tools: readonly ToolSchemaDescriptor[]): ReadonlyMap<string, string> => {
  const names = new Map<string, string>()
  for (const tool of tools) {
    const wire = chatgptFunctionName(tool.toolName)
    if (names.has(wire)) throw new ChatgptError('chatgpt_unsupported_capability', 'not_sent')
    names.set(wire, tool.toolName)
  }
  return names
}

/** Opaque and stable for one agent's model selection; it names nothing a provider could use. */
export const chatgptPromptCacheKey = (attempt: LocalInferenceAttemptRequest): string =>
  createHash('sha256').update(`nessie-computer:${attempt.bindingId}`).digest('hex').slice(0, 32)

/** A hard cap is satisfied only by a documented natural maximum, never by cancellation. */
export const assertChatgptOutputCap = (attempt: LocalInferenceAttemptRequest, model: ChatgptModel): void => {
  if (attempt.maxOutputTokens !== undefined && model.maxOutputTokens > attempt.maxOutputTokens) {
    throw new ChatgptError('chatgpt_output_cap_unsupported', 'not_sent')
  }
}

/** The current verified reference model does not offer an explicit `none` effort. */
export const assertChatgptReasoningEffort = (attempt: LocalInferenceAttemptRequest): void => {
  if (attempt.reasoningEffort !== undefined
    && !['low', 'medium', 'high', 'xhigh', 'max'].includes(attempt.reasoningEffort)) {
    throw new ChatgptError('chatgpt_unsupported_capability', 'not_sent')
  }
}

/** SIWC owns a closed request shape; unsupported Responses fields are unrepresentable. */
export const chatgptRequestBody = (
  attempt: LocalInferenceAttemptRequest, model: ChatgptModel,
): Record<string, unknown> => {
  assertChatgptOutputCap(attempt, model)
  assertChatgptReasoningEffort(attempt)
  chatgptAuthorityRoot(attempt)
  try {
    const pending = new Set<string>()
    for (const message of attempt.messages) {
      if (message.role === 'tool') {
        if (!pending.delete(message.toolCallId)) throw new ChatgptError('chatgpt_protocol_error', 'not_sent')
      } else {
        if (pending.size) throw new ChatgptError('chatgpt_protocol_error', 'not_sent')
        if (message.role === 'assistant' && message.toolCalls?.length) {
          if (!message.responsesContinuation) throw new ChatgptError('chatgpt_protocol_error', 'not_sent')
          for (const call of message.toolCalls) {
            if (pending.has(call.toolCallId)) throw new ChatgptError('chatgpt_protocol_error', 'not_sent')
            pending.add(call.toolCallId)
          }
        }
      }
    }
    if (pending.size) throw new ChatgptError('chatgpt_protocol_error', 'not_sent')
    chatgptToolNames(attempt.tools)
    const mapped = mapMessagesToResponses(attempt.messages, { vision: true,
      continuationItems: (message) => replayChatgptContinuation(message, attempt, model, chatgptFunctionName),
      functionIdentity: (name) => ({ name: chatgptFunctionName(name),
        ...(model.transport === 'codex' ? {} : { namespace: CHATGPT_TOOL_NAMESPACE }) }) })
    const definitions = mapToolsToResponses(attempt.tools)?.map((tool) => ({ ...tool,
      name: chatgptFunctionName(tool.name as string), strict: false }))
    const body = { model: model.providerModelId, input: mapped.input, store: false, stream: true,
      include: ['reasoning.encrypted_content'],
      // One key per agent keeps its long shared prefix (instructions and tools) on the
      // provider's prompt cache from turn to turn; without it each turn is read cold.
      ...(model.transport === 'codex' ? { prompt_cache_key: chatgptPromptCacheKey(attempt) } : {}),
      ...(model.transport === 'codex' ? { instructions: mapped.instructions ?? '' }
        : mapped.instructions ? { instructions: mapped.instructions } : {}),
      ...(definitions ? { tools: model.transport === 'codex' ? definitions
        : [{ type: 'namespace', name: CHATGPT_TOOL_NAMESPACE,
          description: 'Nessie tools authorized for this request.', tools: definitions }] } : {}),
      ...(attempt.thinking || attempt.reasoningEffort ? { reasoning: {
        ...(attempt.reasoningEffort ? { effort: attempt.reasoningEffort } : {}),
        ...(attempt.thinking ? { summary: 'auto' } : {}),
      } } : {}),
    }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 16 * 1024 * 1024) {
      throw new ChatgptError('chatgpt_unsupported_capability', 'not_sent')
    }
    return body
  } catch (error) {
    if (error instanceof ChatgptError) throw error
    throw new ChatgptError('chatgpt_unsupported_capability', 'not_sent')
  }
}
