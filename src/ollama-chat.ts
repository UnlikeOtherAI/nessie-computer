import type {
  LocalInferenceAttemptRequest,
  ProviderMessage,
  ProviderToolCall,
  ResponsesContinuation,
} from '@nessie/executor-protocol'

import {
  assertLoopbackOrigin,
  defaultOllamaFetch,
  type OllamaFetch,
} from './ollama-client.js'
import { assertNoRemoteOllamaMarker, OllamaObservationError } from './ollama-observed.js'

const MAX_CHAT_LINE_BYTES = 64 * 1024
const MAX_TOOL_CALLS = 128

export type OllamaChatEvent = {
  responsesContinuation?: ResponsesContinuation
  done: boolean
  finishReason?: 'length' | 'other' | 'stop' | 'tool-call'
  inputTokens?: number
  outputTokens?: number
  text?: string
  /** The model's separate thinking (`message.thinking`), when asked for. */
  thinking?: string
  toolCalls?: ProviderToolCall[]
}

export class OllamaChatError extends Error {
  override readonly name = 'OllamaChatError'

  constructor(readonly code: 'cancelled' | 'ollama_unreachable' | 'protocol_error' | 'unsupported_capability') {
    super(code)
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
)

const nonEmptyText = (value: unknown, maximum: number): string | undefined => (
  typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : undefined
)

const nonNegativeInteger = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
)

const contentForOllama = (content: Exclude<ProviderMessage['content'], null>): string => {
  if (typeof content === 'string') return content
  let text = ''
  for (const part of content) {
    if (part.type !== 'text') throw new OllamaChatError('unsupported_capability')
    text += part.text
  }
  return text
}

const messageForOllama = (message: ProviderMessage): Record<string, unknown> => {
  if (message.role === 'assistant') {
    return {
      content: message.content === null ? '' : contentForOllama(message.content),
      role: message.role,
      // Ollama's assistant message carries the turn's thinking under the same
      // name it streams it, so a thinking model keeps its own context across
      // a tool round.
      ...(message.reasoning ? { thinking: message.reasoning } : {}),
      ...(message.toolCalls === undefined ? {} : {
        tool_calls: message.toolCalls.map((call) => ({
          function: { arguments: call.arguments, name: call.toolName },
        })),
      }),
    }
  }
  if (message.role === 'tool') {
    return { content: message.content, role: message.role, tool_name: message.toolCallId }
  }
  if (message.content === null) throw new OllamaChatError('protocol_error')
  return { content: contentForOllama(message.content), role: message.role }
}

const toolDefinitionsForOllama = (attempt: LocalInferenceAttemptRequest): Record<string, unknown>[] => (
  attempt.tools.map((tool) => ({
    function: {
      description: tool.description,
      name: tool.toolName,
      parameters: tool.inputSchema,
    },
    type: 'function',
  }))
)

const parseArguments = (value: unknown): Record<string, unknown> | undefined => {
  const direct = asRecord(value)
  if (direct !== undefined) return direct
  if (typeof value !== 'string' || value.length > 16 * 1024) return undefined
  try {
    return asRecord(JSON.parse(value) as unknown)
  } catch {
    return undefined
  }
}

const toolCallsFrom = (
  value: unknown,
  allowedNames: ReadonlySet<string>,
  invocationId: string,
): ProviderToolCall[] => {
  if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS) {
    throw new OllamaChatError('protocol_error')
  }
  return value.map((candidate, index) => {
    const functionValue = asRecord(asRecord(candidate)?.function)
    const name = nonEmptyText(functionValue?.name, 200)
    const argumentsValue = parseArguments(functionValue?.arguments)
    if (name === undefined || argumentsValue === undefined || !allowedNames.has(name)) {
      throw new OllamaChatError('protocol_error')
    }
    return {
      arguments: argumentsValue,
      toolCallId: `${invocationId}:ollama-${index + 1}`,
      toolName: name,
    }
  })
}

const finishReasonFrom = (value: unknown, toolCalls: ProviderToolCall[] | undefined): OllamaChatEvent['finishReason'] => {
  if (toolCalls !== undefined && toolCalls.length > 0) return 'tool-call'
  if (value === 'stop') return 'stop'
  if (value === 'length') return 'length'
  return 'other'
}

const parseChatObject = (
  value: unknown,
  input: LocalInferenceAttemptRequest,
  allowedToolNames: ReadonlySet<string>,
): OllamaChatEvent => {
  const body = asRecord(value)
  if (body === undefined) throw new OllamaChatError('protocol_error')
  assertNoRemoteOllamaMarker(body)
  const reportedModel = body.model
  if (reportedModel !== undefined && reportedModel !== input.modelName) {
    throw new OllamaChatError('protocol_error')
  }
  const message = asRecord(body.message)
  const content = message?.content
  if (content !== undefined && (typeof content !== 'string' || content.length > MAX_CHAT_LINE_BYTES)) {
    throw new OllamaChatError('protocol_error')
  }
  const thinkingValue = message?.thinking
  if (thinkingValue !== undefined
    && (typeof thinkingValue !== 'string' || thinkingValue.length > MAX_CHAT_LINE_BYTES)) {
    throw new OllamaChatError('protocol_error')
  }
  const thinking = typeof thinkingValue === 'string' && thinkingValue.length > 0 ? thinkingValue : undefined
  // Ollama commonly repeats an empty assistant message on its terminal line
  // after the text arrived in earlier chunks. It is valid framing, not a text
  // delta and not a malformed response.
  const text = typeof content === 'string' && content.length > 0 ? content : undefined
  const toolCalls = message?.tool_calls === undefined
    ? undefined
    : toolCallsFrom(message.tool_calls, allowedToolNames, input.invocationId)
  if (body.done !== true && body.done !== false) throw new OllamaChatError('protocol_error')
  return body.done
    ? {
      done: true,
      finishReason: finishReasonFrom(body.done_reason, toolCalls),
      inputTokens: nonNegativeInteger(body.prompt_eval_count),
      outputTokens: nonNegativeInteger(body.eval_count),
      ...(text === undefined ? {} : { text }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
    }
    : {
      done: false,
      ...(text === undefined ? {} : { text }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
    }
}

const linesFrom = async function* (response: Response): AsyncGenerator<string> {
  if (response.body === null) throw new OllamaChatError('protocol_error')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    for (;;) {
      const read = await reader.read()
      if (read.done) break
      pending += decoder.decode(read.value, { stream: true })
      if (Buffer.byteLength(pending, 'utf8') > MAX_CHAT_LINE_BYTES) {
        throw new OllamaChatError('protocol_error')
      }
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line) yield line
      }
    }
    pending += decoder.decode()
    const finalLine = pending.trim()
    if (finalLine) yield finalLine
  } finally {
    reader.releaseLock()
  }
}

/**
 * The only generative Ollama call. Its fixed `/api/chat` path, literal
 * loopback origin and typed body make this an application relay, never an HTTP
 * proxy. The caller owns transport framing and must re-observe the selected
 * model before and after this stream.
 */
export const streamOllamaChat = async function* (input: {
  attempt: LocalInferenceAttemptRequest
  fetchImpl?: OllamaFetch
  origin: string
  signal: AbortSignal
  /**
   * Ask Ollama for the model's separate thinking. The host loop decides this
   * from the attempt's request AND the model's advertised `thinking`
   * capability: Ollama refuses `think: true` on a model without it, and levels
   * (`low`/`medium`/`high`) are accepted by so few models, with no way to
   * discover which, that the switch stays boolean.
   */
  think: boolean
  /** DeepTest may defer physical context allocation to the owner's model configuration. */
  useModelDefaultContext?: true
  /** Supported only on a separately version-verified daemon; context loss must be an error. */
  preventContextLoss?: true
}): AsyncGenerator<OllamaChatEvent> {
  const base = assertLoopbackOrigin(input.origin)
  const fetchImpl = input.fetchImpl ?? defaultOllamaFetch
  const allowedToolNames = new Set(input.attempt.tools.map((tool) => tool.toolName))
  let response: Response
  try {
    response = await fetchImpl(`${base}/api/chat`, {
      body: JSON.stringify({
        keep_alive: '5m',
        messages: input.attempt.messages.map(messageForOllama),
        model: input.attempt.modelName,
        options: {
          ...(input.useModelDefaultContext ? {} : { num_ctx: input.attempt.numCtx }),
          ...(input.attempt.maxOutputTokens === undefined ? {} : { num_predict: input.attempt.maxOutputTokens }),
        },
        stream: true,
        ...(input.preventContextLoss ? { truncate: false, shift: false } : {}),
        // Thinking rides its own stream field and is shown in the thought log;
        // a silent utility call, a `none` effort or a model without the
        // capability leave it off, so a bounded `num_predict` is never spent
        // on hidden thinking.
        think: input.think,
        ...(input.attempt.tools.length === 0 ? {} : { tools: toolDefinitionsForOllama(input.attempt) }),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: input.signal,
    })
  } catch {
    if (input.signal.aborted) throw new OllamaChatError('cancelled')
    throw new OllamaChatError('ollama_unreachable')
  }
  if (!response.ok) throw new OllamaChatError('ollama_unreachable')

  try {
    let sawTerminal = false
    for await (const line of linesFrom(response)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line) as unknown
      } catch {
        throw new OllamaChatError('protocol_error')
      }
      let event: OllamaChatEvent
      try {
        event = parseChatObject(parsed, input.attempt, allowedToolNames)
      } catch (error) {
        if (error instanceof OllamaObservationError) throw new OllamaChatError('protocol_error')
        throw error
      }
      if (sawTerminal) throw new OllamaChatError('protocol_error')
      if (event.done) sawTerminal = true
      yield event
    }
    if (!sawTerminal) throw new OllamaChatError('protocol_error')
  } catch (error) {
    if (error instanceof OllamaChatError) throw error
    if (input.signal.aborted) throw new OllamaChatError('cancelled')
    throw new OllamaChatError('ollama_unreachable')
  }
}
