import { LOCAL_INFERENCE_MALFORMED_ARGUMENTS_KEY, type ProviderMessage, type ProviderToolCall } from '@nessie/executor-protocol'
import type { LocalInferenceStreamInput } from './local-inference-backend.js'
import type { OllamaChatEvent } from './ollama-chat.js'
import { LocalOpenAiError, type LocalOpenAiConfig } from './openai-local-config.js'
import { localOpenAiFetch, localOpenAiHeaders, type LocalOpenAiFetch } from './openai-local-observed.js'

const MAX_FRAME_BYTES = 64 * 1024
const MAX_TOOL_BYTES = 16 * 1024
const invalid = (): never => { throw new LocalOpenAiError('endpoint_protocol_error') }
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const contentForLocalOpenAi = (message: ProviderMessage, vision: boolean): unknown => {
  if (message.content === null || typeof message.content === 'string') return message.content
  if (message.content.every((part) => part.type === 'text')) {
    return message.content.map((part) => part.text).join('')
  }
  if (!vision || message.role !== 'user') throw new LocalOpenAiError('unsupported_capability')
  return message.content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    // The host relays admitted bytes, never a URL that makes the model server fetch a new source.
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.imageUrl)) {
      throw new LocalOpenAiError('unsupported_capability')
    }
    return { type: 'image_url', image_url: { url: part.imageUrl } }
  })
}

export const messageForLocalOpenAi = (message: ProviderMessage, vision = false): Record<string, unknown> => ({
  role: message.role, content: contentForLocalOpenAi(message, vision),
  ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}),
  ...(message.role === 'assistant' && message.reasoning ? { reasoning_content: message.reasoning } : {}),
  ...(message.role === 'assistant' && message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({
    id: call.toolCallId, type: 'function',
    function: { name: call.toolName, arguments: JSON.stringify(call.arguments) },
  })) } : {}),
})

const sseData = async function* (response: Response): AsyncGenerator<string> {
  if (!response.body) return invalid()
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let data: string[] = []
  const lineData = (line: string): string | undefined => {
    if (line === '') {
      if (!data.length) return undefined
      const value = data.join('\n')
      data = []
      return value
    }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    if (Buffer.byteLength(data.join('\n'), 'utf8') > MAX_FRAME_BYTES) return invalid()
    return undefined
  }
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      pending += decoder.decode(next.value, { stream: true })
      for (;;) {
        const index = pending.indexOf('\n')
        if (index < 0) break
        const line = pending.slice(0, index).replace(/\r$/, '')
        pending = pending.slice(index + 1)
        if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) return invalid()
        const value = lineData(line)
        if (value !== undefined) yield value
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_FRAME_BYTES) return invalid()
    }
    pending += decoder.decode()
    if (pending || data.length) return invalid()
  } finally { reader.releaseLock() }
}

type ToolParts = { arguments: string; name: string }
const toolDelta = (value: unknown, parts: Map<number, ToolParts>): void => {
  if (!Array.isArray(value) || value.length > 128) return invalid()
  for (const item of value) {
    if (!record(item) || !Number.isSafeInteger(item.index) || Number(item.index) < 0
      || Number(item.index) >= 128 || !record(item.function)) return invalid()
    const part = parts.get(Number(item.index)) ?? { arguments: '', name: '' }
    for (const key of ['name', 'arguments'] as const) {
      const delta = item.function[key]
      if (delta !== undefined && typeof delta !== 'string') return invalid()
      part[key] += delta ?? ''
    }
    if (part.name.length > 200 || Buffer.byteLength(part.arguments, 'utf8') > MAX_TOOL_BYTES) return invalid()
    parts.set(Number(item.index), part)
  }
}

/**
 * A model's tool call as the worker's own gate will judge it. The host is a
 * relay: a name the catalog does not hold or arguments that are not a JSON
 * object are the model's slips, answered there with a correctable tool result
 * the model reads on its next turn, never by failing the attempt. Only a call
 * with no name at all is the server's protocol error.
 */
const toolsFrom = (parts: Map<number, ToolParts>, input: LocalInferenceStreamInput): ProviderToolCall[] =>
  [...parts].sort(([a], [b]) => a - b).map(([index, part]) => {
    if (!part.name) return invalid()
    let args: unknown
    try { args = part.arguments.trim() ? JSON.parse(part.arguments) as unknown : {} } catch { args = undefined }
    return { toolCallId: `${input.attempt.invocationId}:openai-${index + 1}`, toolName: part.name,
      arguments: record(args) ? args : { [LOCAL_INFERENCE_MALFORMED_ARGUMENTS_KEY]: part.arguments } }
  })

const tokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

export type LocalOpenAiStreamInput = LocalInferenceStreamInput & {
  config: LocalOpenAiConfig
  fetchImpl?: LocalOpenAiFetch
  /** The owner declared this model a thinking model; only then is its thinking switched at all. */
  thinkingModel?: boolean
  /** Enabled only by the owner's model manifest, whose digest is the binding consent pin. */
  visionModel?: boolean
}

/**
 * The thinking switch for an owner-configured server, decided per turn. A
 * shown turn asks with `reasoning_effort` in the agent's own effort; a silent
 * utility turn switches thinking off through the chat template, so a bounded
 * output budget is never spent on hidden reasoning. A model the owner did not
 * declare as thinking receives neither, as its server may refuse the fields.
 */
const reasoningBody = (input: LocalOpenAiStreamInput): Record<string, unknown> => {
  if (!input.thinkingModel) return {}
  if (!input.think) return { chat_template_kwargs: { enable_thinking: false } }
  return input.attempt.reasoningEffort ? { reasoning_effort: input.attempt.reasoningEffort } : {}
}

/** Bounded SSE, exact model, ordinary tool-message round trips and natural-terminal proof. */
export const streamLocalOpenAiChat = async function* (input: LocalOpenAiStreamInput): AsyncGenerator<OllamaChatEvent> {
  let response: Response
  try {
    response = await (input.fetchImpl ?? localOpenAiFetch)(`${input.config.baseUrl}/chat/completions`, {
      method: 'POST', headers: localOpenAiHeaders(input.config), signal: input.signal, redirect: 'error',
      body: JSON.stringify({
        model: input.attempt.modelName,
        messages: input.attempt.messages.map((message) => messageForLocalOpenAi(message, input.visionModel === true)),
        stream: true, stream_options: { include_usage: true },
        ...reasoningBody(input),
        ...(input.attempt.maxOutputTokens === undefined ? {} : { max_tokens: input.attempt.maxOutputTokens }),
        ...(input.attempt.tools.length ? { tools: input.attempt.tools.map((tool) => ({
          type: 'function', function: {
            name: tool.toolName, description: tool.description, parameters: tool.inputSchema,
          },
        })) } : {}),
      }),
    })
  } catch (error) {
    if (error instanceof LocalOpenAiError) throw error
    throw new LocalOpenAiError(input.signal.aborted ? 'cancelled' : 'endpoint_unavailable')
  }
  if (!response.ok) throw new LocalOpenAiError('endpoint_unavailable')
  const parts = new Map<number, ToolParts>()
  let finish: OllamaChatEvent['finishReason']
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let done = false
  try {
    for await (const frame of sseData(response)) {
      if (done) return invalid()
      if (frame === '[DONE]') {
        if (!finish) return invalid()
        const calls = toolsFrom(parts, input)
        // A server that reports `stop` beside complete tool calls still made
        // them; a `tool_calls` finish with none is the protocol error.
        if (finish === 'tool-call' && !calls.length) return invalid()
        done = true
        yield { done: true, finishReason: calls.length ? 'tool-call' : finish, inputTokens, outputTokens,
          ...(calls.length ? { toolCalls: calls } : {}) }
        continue
      }
      let body: unknown
      try { body = JSON.parse(frame) as unknown } catch { return invalid() }
      if (!record(body) || body.error || body.model !== undefined && body.model !== input.attempt.modelName) {
        return invalid()
      }
      if (record(body.usage)) {
        inputTokens = tokenCount(body.usage.prompt_tokens)
        outputTokens = tokenCount(body.usage.completion_tokens)
      }
      if (!Array.isArray(body.choices) || body.choices.length > 1) return invalid()
      if (!body.choices.length) continue
      const choice: unknown = body.choices[0]
      if (!record(choice) || finish || choice.index !== undefined && choice.index !== 0) return invalid()
      const delta = choice.delta
      if (delta !== undefined && !record(delta)) return invalid()
      if (record(delta)) {
        const text = delta.content
        const thinking = delta.reasoning_content ?? delta.reasoning
        if (text !== undefined && text !== null && typeof text !== 'string'
          || thinking !== undefined && thinking !== null && typeof thinking !== 'string') return invalid()
        if (delta.tool_calls !== undefined) toolDelta(delta.tool_calls, parts)
        if (typeof text === 'string' && text) yield { done: false, text }
        if (input.think && typeof thinking === 'string' && thinking) yield { done: false, thinking }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finish = choice.finish_reason === 'tool_calls' ? 'tool-call'
          : choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'stop' ? 'stop' : 'other'
      }
    }
    if (!done) return invalid()
  } catch (error) {
    if (error instanceof LocalOpenAiError) throw error
    throw new LocalOpenAiError(input.signal.aborted ? 'cancelled' : 'endpoint_protocol_error')
  }
}
