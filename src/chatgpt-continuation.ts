import { isDeepStrictEqual } from 'node:util'
import {
  PersonalInferenceAuthoritySchema, ResponsesContinuationSchema, ResponsesReplayItemsSchema,
  decodeProviderToolArguments,
  type LocalInferenceAttemptRequest, type ProviderMessage, type ResponsesContinuation, type ResponsesReplayItem,
} from '@nessie/executor-protocol'
import { sameChatgptSource } from './chatgpt-auth-provider.js'
import { ChatgptError } from './chatgpt-errors.js'
import type { ChatgptModel } from './chatgpt-models.js'

const refuse = (): never => { throw new ChatgptError('chatgpt_protocol_error', 'not_sent') }
export const chatgptAuthorityRoot = (attempt: LocalInferenceAttemptRequest): string => {
  const authority = PersonalInferenceAuthoritySchema.safeParse(
    'personalAuthority' in attempt ? attempt.personalAuthority : undefined,
  )
  if (!authority.success || authority.data.runId !== attempt.runId
    || authority.data.origin.rootRunId !== authority.data.rootRunId) return refuse()
  return authority.data.rootRunId
}

export const chatgptContinuation = (
  items: unknown, attempt: LocalInferenceAttemptRequest, model: ChatgptModel,
): ResponsesContinuation => {
  const parsed = ResponsesContinuationSchema.safeParse({ version: 1, inferenceSource: model.inferenceSource,
    providerModelId: model.providerModelId, rootRunId: chatgptAuthorityRoot(attempt),
    outputItemsJson: JSON.stringify(items) })
  if (!parsed.success) throw new ChatgptError('chatgpt_protocol_error', 'unknown')
  return parsed.data
}

/** Ordered opaque items replace this assistant turn; they never become prompt text or summaries. */
export const replayChatgptContinuation = (
  message: Extract<ProviderMessage, { role: 'assistant' }>, attempt: LocalInferenceAttemptRequest, model: ChatgptModel,
  functionName: (name: string) => string,
): ResponsesReplayItem[] => {
  const parsed = ResponsesContinuationSchema.safeParse(message.responsesContinuation)
  if (!parsed.success || !sameChatgptSource(parsed.data.inferenceSource, model.inferenceSource)
    || parsed.data.providerModelId !== model.providerModelId
    || parsed.data.rootRunId !== chatgptAuthorityRoot(attempt)) return refuse()
  const items = ResponsesReplayItemsSchema.parse(JSON.parse(parsed.data.outputItemsJson))
  const functions = items.filter((item) => item.type === 'function_call')
  const calls = message.toolCalls ?? []
  if (calls.length !== functions.length || functions.some((item, index) => {
    const call = calls[index]!
    const args = decodeProviderToolArguments(item.arguments)
    return item.namespace !== 'nessie' || item.name !== functionName(call.toolName)
      || item.call_id !== call.toolCallId || !isDeepStrictEqual(args, call.arguments)
  })) return refuse()
  const content = items.flatMap((item) => item.type === 'message' ? item.content : [])
    .map((part) => part.type === 'output_text' ? part.text : part.refusal).join('')
  const expected = message.content === null ? '' : typeof message.content === 'string' ? message.content
    : message.content.map((part) => part.type === 'text' ? part.text : refuse()).join('')
  if (content !== expected) return refuse()
  return items
}
