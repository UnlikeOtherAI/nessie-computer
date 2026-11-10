import { decodeProviderToolArguments, type ProviderToolCall } from '@nessie/executor-protocol'
import type { LocalInferenceStreamInput } from './local-inference-backend.js'
import type { ChatgptAccessLease } from './chatgpt-auth-provider.js'
import { sameChatgptSource } from './chatgpt-auth-provider.js'
import type { ChatgptModel } from './chatgpt-models.js'
import type { OllamaChatEvent } from './ollama-chat.js'
import { ChatgptError, chatgptProtocolError, chatgptProviderFailure, isRecord } from './chatgpt-errors.js'
import { CHATGPT_RESPONSES_URL, CHATGPT_PERSONAL_RESPONSES_URL, chatgptHeaders,
  chatgptFetch, readChatgptJson, type ChatgptFetch } from './chatgpt-http.js'
import { CHATGPT_TOOL_NAMESPACE, chatgptRequestBody, chatgptToolNames } from './chatgpt-request.js'
import { chatgptSseData } from './chatgpt-sse.js'
import { chatgptContinuation } from './chatgpt-continuation.js'

const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_TOOL_BYTES = 16 * 1024
type Call = { id: string; callId: string; name: string; arguments: string }

const text = (value: unknown, maximum = 200): string => {
  if (typeof value !== 'string' || !value || value.length > maximum) return chatgptProtocolError()
  return value
}
const tokenCount = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return chatgptProtocolError()
  return value
}
const boundedAppend = (current: string, delta: unknown, maximum: number): string => {
  if (typeof delta !== 'string' || Buffer.byteLength(current + delta, 'utf8') > maximum) return chatgptProtocolError()
  return current + delta
}

const callFrom = (item: Record<string, unknown>, names: ReadonlyMap<string, string>, personal = false): Call => {
  const name = text(item.name)
  if (item.namespace !== (personal ? undefined : CHATGPT_TOOL_NAMESPACE) || !names.has(name)) {
    return chatgptProtocolError()
  }
  const argumentsValue = item.arguments
  if (typeof argumentsValue !== 'string' || Buffer.byteLength(argumentsValue, 'utf8') > MAX_TOOL_BYTES) {
    return chatgptProtocolError()
  }
  return { id: text(item.id), callId: text(item.call_id, 160), name, arguments: argumentsValue }
}

const toolCall = (call: Call, names: ReadonlyMap<string, string>): ProviderToolCall => {
  return { toolCallId: call.callId, toolName: names.get(call.name)!,
    arguments: decodeProviderToolArguments(call.arguments) }
}

/** Only an authenticated completed response with valid usage owns settlement. */
const completed = (
  body: unknown, model: ChatgptModel, streamed: Map<string, Call>, names: ReadonlyMap<string, string>,
) => {
  if (!isRecord(body) || body.status !== 'completed' || body.error || body.model !== model.providerModelId
    || !Array.isArray(body.output) || body.output.length > 256 || !isRecord(body.usage)) return chatgptProtocolError()
  const inputTokens = tokenCount(body.usage.input_tokens)
  const outputTokens = tokenCount(body.usage.output_tokens)
  let output = ''
  const calls: ProviderToolCall[] = []
  const ids = new Set<string>()
  const callIds = new Set<string>()
  for (const item of body.output) {
    if (!isRecord(item)) return chatgptProtocolError()
    const id = text(item.id)
    if (ids.has(id)) return chatgptProtocolError()
    ids.add(id)
    if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) return chatgptProtocolError()
      for (const part of item.content) {
        if (!isRecord(part) || !['output_text', 'refusal'].includes(String(part.type))) return chatgptProtocolError()
        output = boundedAppend(output, part.type === 'refusal' ? part.refusal : part.text, MAX_OUTPUT_BYTES)
      }
    } else if (item.type === 'function_call') {
      const call = callFrom(item, names, model.transport === 'codex')
      if (calls.length >= 128 || callIds.has(call.callId)) return chatgptProtocolError()
      callIds.add(call.callId)
      const prior = streamed.get(call.id)
      if (prior && (prior.callId !== call.callId || prior.name !== call.name || prior.arguments !== call.arguments)) {
        return chatgptProtocolError()
      }
      calls.push(toolCall(call, names))
    } else if (item.type !== 'reasoning') return chatgptProtocolError()
  }
  if ([...streamed.values()].some((call) => !ids.has(call.id) || !callIds.has(call.callId))) {
    return chatgptProtocolError()
  }
  return { id: text(body.id), output, calls, inputTokens, outputTokens }
}

/** One HTTP request, no retry, with strict stream identity and a bounded terminal receipt. */
export const streamChatgptResponse = async function* (input: LocalInferenceStreamInput & {
  model: ChatgptModel
  lease: ChatgptAccessLease
  fetchImpl?: ChatgptFetch
}): AsyncGenerator<OllamaChatEvent> {
  const { attempt, model, lease } = input
  if (attempt.inferenceSource?.kind !== 'chatgpt' || !sameChatgptSource(attempt.inferenceSource, model.inferenceSource)
    || attempt.modelName !== model.name || attempt.modelDigest !== model.manifestDigest) {
    throw new ChatgptError('chatgpt_model_missing', 'not_sent')
  }
  if (attempt.numCtx > model.numCtxCap) throw new ChatgptError('chatgpt_unsupported_capability', 'not_sent')
  const request = chatgptRequestBody(attempt, model)
  const names = chatgptToolNames(attempt.tools)
  const signal = AbortSignal.any([input.signal, lease.signal])
  if (signal.aborted) throw new ChatgptError('chatgpt_cancelled', 'not_sent')
  let response: Response
  try {
    const endpoint = lease.accountId ? CHATGPT_PERSONAL_RESPONSES_URL : CHATGPT_RESPONSES_URL
    response = await (input.fetchImpl ?? chatgptFetch)(endpoint, {
      method: 'POST', redirect: 'error', signal, body: JSON.stringify(request),
      headers: { ...chatgptHeaders(lease),
        'Content-Type': 'application/json', Accept: 'text/event-stream' },
    })
  } catch { throw new ChatgptError(signal.aborted ? 'chatgpt_cancelled' : 'chatgpt_usage_unknown', 'unknown') }
  if (!response.ok) throw chatgptProviderFailure(await readChatgptJson(response), response.status)
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream') {
    await response.body?.cancel().catch(() => undefined)
    return chatgptProtocolError()
  }
  const calls = new Map<string, Call>()
  let responseId: string | undefined
  let output = ''
  let reasoning = ''
  for await (const frame of chatgptSseData(response, signal)) {
    if (frame === '[DONE]') throw new ChatgptError('chatgpt_usage_unknown', 'unknown')
    let event: unknown
    try { event = JSON.parse(frame) as unknown } catch { return chatgptProtocolError() }
    if (!isRecord(event) || typeof event.type !== 'string') return chatgptProtocolError()
    if (event.response_id !== undefined && responseId !== undefined && event.response_id !== responseId) {
      return chatgptProtocolError()
    }
    if (event.type === 'response.created' || event.type === 'response.in_progress') {
      if (!isRecord(event.response) || event.response.model !== model.providerModelId) return chatgptProtocolError()
      const id = text(event.response.id)
      if (responseId !== undefined && responseId !== id) return chatgptProtocolError()
      responseId = id
    } else if (event.type === 'response.output_item.added') {
      if (!isRecord(event.item)) return chatgptProtocolError()
      if (event.item.type === 'function_call') {
        const call = callFrom(event.item, names, model.transport === 'codex')
        if (calls.size >= 128 || calls.has(call.id) || [...calls.values()].some((c) => c.callId === call.callId)) {
          return chatgptProtocolError()
        }
        calls.set(call.id, call)
      } else if (!['message', 'reasoning'].includes(String(event.item.type))) return chatgptProtocolError()
    } else if (event.type === 'response.function_call_arguments.delta') {
      const call = calls.get(text(event.item_id))
      if (!call) return chatgptProtocolError()
      call.arguments = boundedAppend(call.arguments, event.delta, MAX_TOOL_BYTES)
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      output = boundedAppend(output, event.delta, MAX_OUTPUT_BYTES)
      yield { done: false, text: event.delta as string }
    } else if (event.type === 'response.reasoning_summary_text.delta'
      || event.type === 'response.reasoning_text.delta') {
      reasoning = boundedAppend(reasoning, event.delta, MAX_OUTPUT_BYTES)
      if (input.think) yield { done: false, thinking: event.delta as string }
    } else if (event.type === 'response.completed') {
      const terminal = completed(event.response, model, calls, names)
      if (responseId !== undefined && terminal.id !== responseId || !terminal.output.startsWith(output)) {
        return chatgptProtocolError()
      }
      const remaining = terminal.output.slice(output.length)
      yield { done: true, finishReason: terminal.calls.length ? 'tool-call' : 'stop',
        responsesContinuation: chatgptContinuation((event.response as Record<string, unknown>).output, attempt, model),
        inputTokens: terminal.inputTokens, outputTokens: terminal.outputTokens,
        ...(remaining ? { text: remaining } : {}), ...(terminal.calls.length ? { toolCalls: terminal.calls } : {}) }
      return
    } else if (event.type === 'response.failed') {
      throw chatgptProviderFailure(event.response)
    } else if (event.type === 'error') {
      throw chatgptProviderFailure({ error: event })
    } else if (event.type === 'response.incomplete') {
      throw new ChatgptError('chatgpt_usage_unknown', 'unknown')
    } else if (![
      'response.output_item.done', 'response.content_part.added', 'response.content_part.done',
      'response.output_text.done', 'response.function_call_arguments.done',
      'response.refusal.done',
      'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
      'response.reasoning_summary_text.done', 'response.reasoning_text.done',
    ].includes(event.type)) return chatgptProtocolError()
  }
  throw new ChatgptError('chatgpt_usage_unknown', 'unknown')
}
