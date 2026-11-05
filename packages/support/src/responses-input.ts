import type { ProviderMessage as SchemaMessage, ResponsesReplayItem } from '@nessie/executor-protocol'
import type { ProviderMessage, ToolSchemaDescriptor } from './provider-message.js'

export type ResponsesFunctionIdentity = { name: string; namespace?: string }
export type ResponsesInputItem =
  | ResponsesReplayItem
  | { role: 'user' | 'assistant' | 'developer'; content: Array<Record<string, unknown>> }
  | ({ type: 'function_call'; call_id: string; arguments: string } & ResponsesFunctionIdentity)
  | { type: 'function_call_output'; call_id: string; output: string }

const parts = (
  content: SchemaMessage['content'], role: 'user' | 'assistant' | 'developer', vision: boolean,
): Array<Record<string, unknown>> => {
  if (content === null) return []
  const values = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content
  return values.map((part) => {
    if (part.type === 'text') return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
    if (role !== 'user' || !vision) throw new Error('This Responses input does not support images.')
    return { type: 'input_image', image_url: part.imageUrl }
  })
}

/** One history mapping for Responses consumers; request options stay provider-owned. */
export const mapMessagesToResponses = (
  messages: readonly (ProviderMessage | SchemaMessage)[],
  options: { vision: boolean; functionIdentity?: (name: string) => ResponsesFunctionIdentity
    continuationItems?: (message: Extract<ProviderMessage | SchemaMessage, { role: 'assistant' }>) => ResponsesReplayItem[] },
): { input: ResponsesInputItem[]; instructions?: string } => {
  const instructions: string[] = []
  const input: ResponsesInputItem[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      const content = parts(message.content, 'developer', false)
      if (input.length === 0) instructions.push(content.map((part) => part.text as string).join(''))
      else input.push({ role: 'developer', content })
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content })
    } else if (message.role === 'assistant') {
      if (message.responsesContinuation) {
        if (!options.continuationItems) throw new Error('This provider cannot replay Responses continuation state.')
        input.push(...options.continuationItems(message))
        continue
      }
      if (message.content) input.push({ role: 'assistant', content: parts(message.content, 'assistant', false) })
      for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.toolCallId,
        ...(options.functionIdentity?.(call.toolName) ?? { name: call.toolName }),
        arguments: JSON.stringify(call.arguments ?? {}) })
    } else {
      const content = parts(message.content, 'user', options.vision)
      if ('images' in message && options.vision) for (const image of message.images ?? []) content.push({
        type: 'input_image', image_url: `data:${image.mime};base64,${image.dataBase64}`,
      })
      input.push({ role: 'user', content })
    }
  }
  return { input, ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}) }
}

/** Flat function definitions remain Grok's wire contract; SIWC groups them explicitly. */
export const mapToolsToResponses = (
  tools: readonly ToolSchemaDescriptor[] | undefined,
): Array<Record<string, unknown>> | undefined =>
  tools?.length ? tools.map((tool) => ({ type: 'function', name: tool.toolName,
    description: tool.description, parameters: tool.inputSchema })) : undefined
