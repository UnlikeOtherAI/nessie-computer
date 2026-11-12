import { LOCAL_INFERENCE_FRAME_COALESCE_BYTES, LOCAL_INFERENCE_FRAME_COALESCE_MS } from '@nessie/local-inference-host'
import type { LocalInferenceAttemptRequest, LocalInferenceResult, ModelCapabilitySnapshot } from '@nessie/executor-protocol'

import type { LocalInferenceStreamFrameType } from './local-inference-frames.js'
import type { OllamaFetch } from './ollama-client.js'
import { OllamaChatError, streamOllamaChat } from './ollama-chat.js'
import type { LocalInferenceBackend } from './local-inference-backend.js'

const MAX_OUTPUT_BYTES = 512 * 1024

/** Sends one frame (or a few, at the wire cap) and returns; nothing waits for it. */
type Publish = (type: LocalInferenceStreamFrameType, text: string, final: boolean) => void

/**
 * Buffers a stream's deltas into bounded, ordered frames sent beside the
 * model stream rather than inside it. Frames are relayed, never acknowledged:
 * a lost one only means the receipt supplies the rest of the text.
 */
class CoalescingFramePublisher {
  #type: LocalInferenceStreamFrameType | undefined
  #text = ''
  #timer: NodeJS.Timeout | undefined
  #failure: { error: unknown } | undefined
  /** Whether this stream has sent anything yet: its first words never wait for the window. */
  #started = false

  constructor(private readonly publish: Publish, private readonly windowMs: number) {}

  push(type: LocalInferenceStreamFrameType, text: string): void {
    if (this.#failure) throw this.#failure.error
    if (this.#type !== undefined && this.#type !== type) this.flush(false)
    this.#type = type
    this.#text += text
    if (!this.#started || Buffer.byteLength(this.#text, 'utf8') >= LOCAL_INFERENCE_FRAME_COALESCE_BYTES) this.flush(false)
    else if (!this.#timer) this.#timer = setTimeout(() => this.flush(false), this.windowMs)
  }

  /** The last flush of a natural end is marked final, with or without text. */
  flush(final: boolean): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined }
    const text = this.#text
    this.#text = ''
    if (this.#failure || !final && (this.#type === undefined || !text)) return
    this.#started = true
    try { this.publish(this.#type ?? 'output_text.delta', text, final) }
    catch (error) { this.#failure = { error } }
  }

  settle(final: boolean): void {
    this.flush(final)
  }

  get failure(): { error: unknown } | undefined { return this.#failure }

  abandon(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#text = ''
  }
}

/** Validate one model stream; the receipt, not the frames, is its record. */
export const runLocalInferenceGeneration = async (input: {
  attempt: LocalInferenceAttemptRequest
  capability: () => ModelCapabilitySnapshot
  coalesceMs?: number
  fetchImpl?: OllamaFetch
  origin: string
  signal: AbortSignal
  think: boolean
  stream?: LocalInferenceBackend['stream']
  publish: Publish
  terminal: () => Promise<void>
  now?: () => number
}): Promise<LocalInferenceResult> => {
  const now = input.now ?? Date.now
  let content = ''
  let reasoning = ''
  let finishReason: LocalInferenceResult['finishReason'] = 'other'
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  let toolCalls: LocalInferenceResult['toolCalls'] = []
  let responsesContinuation: LocalInferenceResult['responsesContinuation']
  const frames = new CoalescingFramePublisher(input.publish, input.coalesceMs ?? LOCAL_INFERENCE_FRAME_COALESCE_MS)
  // From sending the model request to the end of its stream: the host's own
  // measure, so the server can tell transport time from model time.
  const startedAt = now()
  let generationMs: number
  try {
    for await (const event of (input.stream ?? streamOllamaChat)(input)) {
      if (event.thinking !== undefined) {
        if (Buffer.byteLength(reasoning + event.thinking, 'utf8') > MAX_OUTPUT_BYTES) {
          throw new OllamaChatError('protocol_error')
        }
        reasoning += event.thinking
        frames.push('reasoning_text.delta', event.thinking)
      }
      if (event.text !== undefined) {
        if (Buffer.byteLength(content + event.text, 'utf8') > MAX_OUTPUT_BYTES) throw new OllamaChatError('protocol_error')
        content += event.text
        frames.push('output_text.delta', event.text)
      }
      if (event.toolCalls !== undefined) toolCalls = event.toolCalls
      if (event.done) {
        responsesContinuation = event.responsesContinuation
        finishReason = event.finishReason ?? 'other'
        inputTokens = event.inputTokens ?? null
        outputTokens = event.outputTokens ?? null
      }
    }
    generationMs = Math.max(0, Math.round(now() - startedAt))
    frames.settle(true)
  } catch (error) {
    // An incomplete drain lacks a terminal proof and is never reported as
    // another model call; the caller records the failure in the receipt.
    frames.abandon()
    throw error
  }
  // The stream reached its natural end, so this is a terminal proof even if
  // its last frame could not be sent.
  await input.terminal()
  if (frames.failure) throw frames.failure.error
  return {
    ...(responsesContinuation ? { responsesContinuation } : {}),
    ...(input.attempt.inferenceSource ? { inferenceSource: input.attempt.inferenceSource } : {}),
    capability: input.capability(),
    content: content || null,
    finishReason,
    generationMs,
    modelDigest: input.attempt.modelDigest,
    reasoning: reasoning || null,
    remoteHost: null,
    remoteModel: null,
    toolCalls,
    usage: { inputTokens, outputTokens },
  }
}
