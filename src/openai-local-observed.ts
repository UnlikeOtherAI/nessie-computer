import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'

import type { LocalInferenceBackend, ObservedInferenceModel } from './local-inference-backend.js'
import { LocalOpenAiError, localOpenAiManifestDigest, type LocalOpenAiConfig } from './openai-local-config.js'
import { streamLocalOpenAiChat } from './openai-local-chat.js'

export type LocalOpenAiFetch = (url: string, init: RequestInit) => Promise<Response>

/** Literal loopback only, no redirect can move a body or credential off this computer. */
export const localOpenAiFetch: LocalOpenAiFetch = (url, init) =>
  // Use the bundled transport: older Node fetch parsers can crash on FIN while a body is paused.
  undiciFetch(url, { ...init, redirect: 'error' } as UndiciRequestInit) as unknown as Promise<Response>

export const localOpenAiHeaders = (config: LocalOpenAiConfig): Record<string, string> => ({
  'content-type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
})

export const boundedOpenAiJson = async (response: Response, maximum = 256 * 1024): Promise<unknown> => {
  if (!response.ok || !response.body) throw new LocalOpenAiError('endpoint_unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) { await reader.cancel(); throw new LocalOpenAiError('endpoint_response_too_large') }
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    if (error instanceof LocalOpenAiError) throw error
    throw new LocalOpenAiError('endpoint_response_invalid')
  } finally { reader.releaseLock() }
}

export const observeLocalOpenAiModels = async (
  config: LocalOpenAiConfig, fetchImpl: LocalOpenAiFetch = localOpenAiFetch,
): Promise<ObservedInferenceModel[]> => {
  let body: unknown
  try {
    body = await boundedOpenAiJson(await fetchImpl(`${config.baseUrl}/models`, {
      headers: localOpenAiHeaders(config), signal: AbortSignal.timeout(3_000), redirect: 'error',
    }))
  } catch (error) {
    if (error instanceof LocalOpenAiError) throw error
    throw new LocalOpenAiError('endpoint_unavailable')
  }
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data) || data.length > 100) throw new LocalOpenAiError('endpoint_response_invalid')
  const servedLimits = new Map<string, number | undefined>()
  const ids = new Set(data.map((entry: unknown) => {
    const id = (entry as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id || id.length > 200) throw new LocalOpenAiError('endpoint_response_invalid')
    if (servedLimits.has(id)) throw new LocalOpenAiError('endpoint_response_invalid')
    const meta = (entry as { meta?: { n_ctx?: unknown } }).meta
    const limit = meta?.n_ctx
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit)
      || limit < 1 || limit > 1_000_000)) throw new LocalOpenAiError('endpoint_response_invalid')
    servedLimits.set(id, typeof limit === 'number' ? limit : undefined)
    return id
  }))
  for (const model of config.models) {
    const limit = servedLimits.get(model.id)
    if (limit !== undefined && model.contextLength > limit) {
      throw new LocalOpenAiError('endpoint_context_exceeds_served')
    }
  }
  return config.models.filter((model) => ids.has(model.id)).map((model) => ({
    name: model.id, manifestDigest: localOpenAiManifestDigest(config, model),
    identitySource: 'owner_configuration', modelRevision: model.revision,
    capabilities: ['completion', ...(model.tools ? ['tools'] : []), ...(model.thinking ? ['thinking'] : []),
      ...(model.vision ? ['vision'] : [])],
    numCtxCap: model.contextLength, maxOutputTokens: model.maxOutputTokens,
    remoteHost: null, remoteModel: null, sizeBytes: null,
  }))
}

/** Re-read protected configuration on every observation and invocation, so edits fence old model pins. */
export const createLocalOpenAiBackend = (
  readConfig: () => Promise<LocalOpenAiConfig | null>, fetchImpl: LocalOpenAiFetch = localOpenAiFetch,
): LocalInferenceBackend => ({
  observe: async () => {
    const config = await readConfig()
    if (!config) throw new LocalOpenAiError('endpoint_configuration_missing')
    return observeLocalOpenAiModels(config, fetchImpl)
  },
  stream: async function* (input) {
    const config = await readConfig()
    const selected = config?.models.find((model) => model.id === input.attempt.modelName)
    if (!config || !selected || localOpenAiManifestDigest(config, selected) !== input.attempt.modelDigest) {
      throw new LocalOpenAiError('endpoint_model_changed')
    }
    if (input.attempt.numCtx > selected.contextLength
      || input.attempt.tools.length && !selected.tools
      || input.attempt.maxOutputTokens !== undefined && input.attempt.maxOutputTokens > selected.maxOutputTokens) {
      throw new LocalOpenAiError('unsupported_capability')
    }
    yield* streamLocalOpenAiChat({ ...input,
      attempt: { ...input.attempt, maxOutputTokens: input.attempt.maxOutputTokens ?? selected.maxOutputTokens },
      config, fetchImpl, thinkingModel: selected.thinking, visionModel: selected.vision === true })
  },
})
