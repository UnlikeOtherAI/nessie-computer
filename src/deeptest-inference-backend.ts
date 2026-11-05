import { randomUUID } from 'node:crypto'
import type { LocalInferenceAttemptRequest } from '@nessie/executor-protocol'
import { createOllamaBackend, type LocalInferenceBackend } from './local-inference-backend.js'
import { DEFAULT_OLLAMA_ORIGIN } from './ollama-client.js'
import { isStructurallyLocalOllamaModel } from './ollama-observed.js'
import { createLocalOpenAiBackend } from './openai-local-observed.js'
import { readLocalOpenAiConfig } from './openai-local-config.js'
import { createDeepTestCodingBackends } from './deeptest-inference-coding.js'
import { inferenceModelId, type DeepTestInferenceChat, type DeepTestInferenceModel, type DeepTestInferenceResult } from './deeptest-inference-protocol.js'
import type { DeepTestInferenceGrant } from './deeptest-inference-grant.js'

export type DeepTestInferenceBackend = {
  models: () => Promise<DeepTestInferenceModel[]>
  chat: (request: DeepTestInferenceChat, signal: AbortSignal) => Promise<DeepTestInferenceResult>
}

export const createDeepTestLocalBackend = (engine: 'ollama' | 'openai', backend: LocalInferenceBackend,
  options: { ollamaContextLength?: number } = {}): DeepTestInferenceBackend => {
  const configuredContext = engine === 'ollama' ? options.ollamaContextLength : undefined
  const contextCap = (architecturalCap: number | null) => configuredContext === undefined
    ? architecturalCap : architecturalCap === null ? configuredContext : Math.min(configuredContext, architecturalCap)
  const eligible = async () => (await backend.observe()).filter((model) =>
    isStructurallyLocalOllamaModel(model) && model.capabilities.includes('completion')
    && Buffer.byteLength(model.name, 'utf8') <= 384)
  const models = async () => (await eligible()).map((model) => ({
    id: inferenceModelId(engine, model.name), label: model.name, engine,
    model_digest: model.manifestDigest, context_length: contextCap(model.numCtxCap),
    max_output_tokens: model.maxOutputTokens ?? null,
    capabilities: ['text', ...(model.capabilities.includes('tools') ? ['tools'] : []),
      ...(model.capabilities.includes('thinking') ? ['thinking'] : [])],
  }))
  return {
    models,
    chat: async (request, signal) => {
      const selected = (await eligible()).find((model) => inferenceModelId(engine, model.name) === request.model_id
        && model.manifestDigest === request.model_digest)
      if (!selected) throw new Error('MODEL_CHANGED')
      const cap = contextCap(selected.numCtxCap)
      const context = request.context_length ?? cap
      if (context === null || context === undefined || cap !== null && context > cap
        || request.max_output_tokens !== undefined && selected.maxOutputTokens !== undefined
          && request.max_output_tokens > selected.maxOutputTokens
        || request.tools.length && !selected.capabilities.includes('tools')
        || request.thinking && !selected.capabilities.includes('thinking')) throw new Error('UNSUPPORTED_CAPABILITY')
      // These are process-local invocation identities, never a hosted Nessie run or paid receipt.
      const invocation = randomUUID()
      const attempt: LocalInferenceAttemptRequest = {
        attemptId: invocation, bindingId: invocation, bindingRevision: 1,
        deadlineAt: new Date(0).toISOString(), hostEpoch: 1, hostId: invocation,
        invocationId: invocation, messages: request.messages, tools: request.tools,
        modelDigest: request.model_digest, modelName: selected.name, numCtx: context,
        protocolVersion: 1, runId: invocation, runFence: invocation,
        ...(request.max_output_tokens === undefined ? {} : { maxOutputTokens: request.max_output_tokens }),
        ...(request.reasoning_effort === undefined ? {} : { reasoningEffort: request.reasoning_effort }),
      }
      const result: DeepTestInferenceResult = {
        model_id: request.model_id, model_digest: request.model_digest, content: null, reasoning: null,
        tool_calls: [], finish_reason: 'other', usage: { input_tokens: null, output_tokens: null },
      }
      let completed = false
      let bytes = 0
      const stream = backend.stream({ attempt, origin: DEFAULT_OLLAMA_ORIGIN, signal,
        think: request.thinking === true,
        ...(engine === 'ollama' && request.context_length === undefined && configuredContext === undefined
          ? { useModelDefaultContext: true as const } : {}),
      })
      for await (const event of stream) {
        if (signal.aborted) throw new Error('CANCELLED')
        bytes += Buffer.byteLength(JSON.stringify(event), 'utf8')
        if (bytes > 16 * 1024 * 1024) throw new Error('OUTPUT_BYTES_LIMIT')
        if (event.text) result.content = (result.content ?? '') + event.text
        if (event.thinking) result.reasoning = (result.reasoning ?? '') + event.thinking
        if (event.toolCalls) {
          for (const call of event.toolCalls) {
            // Ollama emits complete calls in separate chunks, whose parser IDs
            // start at one each time. Scope IDs to this assembled response.
            result.tool_calls.push(engine === 'ollama'
              ? { ...call, toolCallId: `${invocation}:ollama-${result.tool_calls.length + 1}` } : call)
          }
        }
        if (event.done) {
          completed = true
          result.finish_reason = event.finishReason ?? 'other'
          result.usage = { input_tokens: event.inputTokens ?? null, output_tokens: event.outputTokens ?? null }
        }
      }
      if (!completed) throw new Error('INFERENCE_INCOMPLETE')
      // Ollama can stream tool proposals before an empty terminal `stop` line.
      // Classify the completed response from all retained calls, while leaving
      // physical length/errors incomplete rather than treating them as tools.
      if (result.tool_calls.length > 0 && result.finish_reason === 'stop') result.finish_reason = 'tool-call'
      const verified = (await eligible()).some((model) =>
        model.name === selected.name && model.manifestDigest === selected.manifestDigest)
      if (!verified || signal.aborted) throw new Error(signal.aborted ? 'CANCELLED' : 'MODEL_CHANGED')
      return result
    },
  }
}

export const createDeepTestInferenceBackends = async (
  stateDir: string, grant: DeepTestInferenceGrant,
): Promise<Partial<Record<string, DeepTestInferenceBackend>>> => ({
  ...(grant.engines.includes('ollama') ? { ollama: createDeepTestLocalBackend('ollama',
    createOllamaBackend(DEFAULT_OLLAMA_ORIGIN, { requireUntruncatedContext: true }),
    { ollamaContextLength: grant.ollamaContextLength }) } : {}),
  ...(grant.engines.includes('openai') ? { openai: createDeepTestLocalBackend('openai', createLocalOpenAiBackend(() => readLocalOpenAiConfig(stateDir))) } : {}),
  ...await createDeepTestCodingBackends(stateDir, grant),
})
