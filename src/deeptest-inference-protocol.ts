import { ProviderMessageSchema, ToolSchemaDescriptorSchema, type ProviderMessage, type ToolSchemaDescriptor } from '@nessie/executor-protocol'
import { parseDeepTestSourceRequest, type DeepTestSourceBinding } from './deeptest-source-protocol.js'
import type { DeepTestInferenceEngine } from './deeptest-inference-grant.js'

export type DeepTestInferenceModel = {
  id: string
  label: string
  engine: DeepTestInferenceEngine
  model_digest: string
  context_length: number | null
  max_output_tokens: number | null
  capabilities: string[]
}
export type DeepTestInferenceRequest = DeepTestSourceBinding & {
  protocol_version: 1
  request_id: string
} & ({ operation: 'hello' } | { operation: 'inference.models' } | {
  operation: 'inference.chat'
  model_id: string
  model_digest: string
  messages: ProviderMessage[]
  tools: ToolSchemaDescriptor[]
  context_length?: number
  max_output_tokens?: number
  thinking?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
})
export type DeepTestInferenceChat = Extract<DeepTestInferenceRequest, { operation: 'inference.chat' }>
export type DeepTestInferenceResult = {
  model_id: string
  model_digest: string
  content: string | null
  reasoning: string | null
  tool_calls: Array<{ toolCallId: string; toolName: string; arguments: Record<string, unknown> }>
  finish_reason: 'stop' | 'length' | 'tool-call' | 'other'
  usage: { input_tokens: number | null; output_tokens: number | null }
}
export type DeepTestInferenceResponse = {
  protocol_version: 1; request_id: string; status: 'ok'; result: Record<string, unknown>
} | {
  protocol_version: 1; request_id: string; status: 'error'
  error: { code: string; message: string; retryable: boolean }
}
const baseKeys = ['account_id', 'project_id', 'review_id', 'session_id', 'protocol_version', 'request_id', 'operation']
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (): never => { throw new Error('REQUEST_INVALID') }
const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000

/** Closed local grammar. Provider credentials, paths, URLs and native argv are never accepted. */
export const parseDeepTestInferenceRequest = (input: unknown): DeepTestInferenceRequest => {
  if (!record(input)) return invalid()
  const base = Object.fromEntries(baseKeys.map((key) => [key, key === 'operation' ? 'hello' : input[key]]))
  parseDeepTestSourceRequest(base)
  const chatKeys = ['model_id', 'model_digest', 'messages', 'tools', 'context_length',
    'max_output_tokens', 'thinking', 'reasoning_effort']
  const allowed = [...baseKeys, ...(input.operation === 'inference.chat' ? chatKeys : [])]
  if (Object.keys(input).some((key) => !allowed.includes(key))) return invalid()
  if (input.operation === 'hello' || input.operation === 'inference.models') return input as DeepTestInferenceRequest
  if (input.operation !== 'inference.chat'
    || typeof input.model_id !== 'string' || !/^(ollama|openai|codex|claude):[A-Za-z0-9_-]{1,512}$/u.test(input.model_id)
    || typeof input.model_digest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.model_digest)
    || input.context_length !== undefined && !number(input.context_length)
    || input.max_output_tokens !== undefined && !number(input.max_output_tokens)
    || input.thinking !== undefined && typeof input.thinking !== 'boolean'
    || input.reasoning_effort !== undefined && !['low', 'medium', 'high'].includes(String(input.reasoning_effort))
    || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 1000
    || !Array.isArray(input.tools) || input.tools.length > 128) return invalid()
  for (const message of input.messages) {
    const parsed = ProviderMessageSchema.safeParse(message)
    if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(message)) {
      // Object key order is immaterial; compare keys below rather than accepting schema stripping.
      if (!parsed.success || !record(message)
        || Object.keys(message).some((key) => !Object.hasOwn(parsed.data, key))) return invalid()
    }
    if (!parsed.success || (typeof parsed.data.content !== 'string' && parsed.data.content !== null)) return invalid()
    if (record(message) && ('responsesContinuation' in message || 'historicalContext' in message)) return invalid()
    if (record(message) && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        if (!record(call) || Object.keys(call).some((key) => !['toolCallId', 'toolName', 'arguments'].includes(key))) return invalid()
      }
    }
  }
  for (const tool of input.tools) {
    if (!record(tool) || Object.keys(tool).some((key) => !['toolName', 'description', 'inputSchema'].includes(key))
      || !ToolSchemaDescriptorSchema.safeParse(tool).success || String(tool.toolName).length > 200) return invalid()
  }
  const names = input.tools.map((tool) => (tool as { toolName: string }).toolName)
  if (new Set(names).size !== input.tools.length) return invalid()
  return input as DeepTestInferenceRequest
}

export const inferenceModelId = (engine: DeepTestInferenceEngine, name: string): string =>
  `${engine}:${Buffer.from(name, 'utf8').toString('base64url')}`
