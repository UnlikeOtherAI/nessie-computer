import { createHash } from 'node:crypto'

import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'

import type { LocalInferenceBackend, ObservedInferenceModel } from './local-inference-backend.js'
import {
  LocalOpenAiError, localModelServerOrigin, localOpenAiApiBase, type LocalOpenAiConfig,
} from './openai-local-config.js'
import { streamLocalOpenAiChat } from './openai-local-chat.js'
import { reportedModelFrom, serverPropsFrom, type ReportedModel, type ServerProps } from './openai-local-report.js'

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

const request = (config: LocalOpenAiConfig) => ({
  headers: localOpenAiHeaders(config), signal: AbortSignal.timeout(3_000), redirect: 'error' as const,
})

/** `/props` is llama.cpp's; any other server answering otherwise simply has no props to add. */
const readServerProps = async (config: LocalOpenAiConfig, fetchImpl: LocalOpenAiFetch): Promise<ServerProps | null> => {
  let response: Response
  try { response = await fetchImpl(`${localModelServerOrigin(config)}/props`, request(config)) } catch { return null }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); return null }
  try { return serverPropsFrom(await boundedOpenAiJson(response, 1024 * 1024)) } catch { return null }
}

/** A changed address, context, capability or set of weights is a different model to consent to. */
export const reportedModelDigest = (config: LocalOpenAiConfig, model: ReportedModel): string =>
  createHash('sha256').update(canonicalExecutorJson({
    protocol: 'openai-chat-completions-v1', baseUrl: localOpenAiApiBase(config), id: model.id,
    numCtxCap: model.numCtxCap, maxOutputTokens: model.maxOutputTokens,
    thinking: model.thinking, tools: model.tools, vision: model.vision, weights: model.weights,
  })).digest('hex')

export const readReportedModels = async (
  config: LocalOpenAiConfig, fetchImpl: LocalOpenAiFetch = localOpenAiFetch,
): Promise<ReportedModel[]> => {
  let body: unknown
  try {
    body = await boundedOpenAiJson(await fetchImpl(`${localOpenAiApiBase(config)}/models`, request(config)))
  } catch (error) {
    if (error instanceof LocalOpenAiError) throw error
    throw new LocalOpenAiError('endpoint_unavailable')
  }
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data) || data.length > 100) throw new LocalOpenAiError('endpoint_response_invalid')
  const entries = data.map((entry: unknown) => {
    const id = (entry as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id || id.length > 200) throw new LocalOpenAiError('endpoint_response_invalid')
    return { entry: entry as Record<string, unknown>, id }
  })
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) throw new LocalOpenAiError('endpoint_response_invalid')
  const props = await readServerProps(config, fetchImpl)
  // Props describe the one loaded model: the one they name, or the only one listed.
  const propsFor = (id: string) => props && (props.alias === id || entries.length === 1) ? props : null
  return entries.flatMap(({ entry, id }) => reportedModelFrom(entry, id, propsFor(id)) ?? [])
}

const observedFrom = (config: LocalOpenAiConfig, model: ReportedModel): ObservedInferenceModel => ({
  name: model.id, manifestDigest: reportedModelDigest(config, model),
  identitySource: 'owner_configuration',
  capabilities: ['completion', ...(model.tools ? ['tools'] : []), ...(model.thinking ? ['thinking'] : []),
    ...(model.vision ? ['vision'] : [])],
  numCtxCap: model.numCtxCap, ...(model.maxOutputTokens === null ? {} : { maxOutputTokens: model.maxOutputTokens }),
  remoteHost: null, remoteModel: null, sizeBytes: null,
})

export const observeLocalOpenAiModels = async (
  config: LocalOpenAiConfig, fetchImpl: LocalOpenAiFetch = localOpenAiFetch,
): Promise<ObservedInferenceModel[]> =>
  (await readReportedModels(config, fetchImpl)).map((model) => observedFrom(config, model))

/**
 * Ask the server again on every observation and invocation, so a model it no
 * longer serves as consented fences the old pin before anything is sent.
 */
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
    if (!config) throw new LocalOpenAiError('endpoint_model_changed')
    const selected = (await readReportedModels(config, fetchImpl)).find((model) =>
      model.id === input.attempt.modelName && reportedModelDigest(config, model) === input.attempt.modelDigest)
    if (!selected) throw new LocalOpenAiError('endpoint_model_changed')
    if (selected.numCtxCap !== null && input.attempt.numCtx > selected.numCtxCap
      || input.attempt.tools.length && !selected.tools
      || input.attempt.maxOutputTokens !== undefined && selected.maxOutputTokens !== null
        && input.attempt.maxOutputTokens > selected.maxOutputTokens) {
      throw new LocalOpenAiError('unsupported_capability')
    }
    const maxOutputTokens = input.attempt.maxOutputTokens ?? selected.maxOutputTokens ?? undefined
    yield* streamLocalOpenAiChat({ ...input,
      attempt: { ...input.attempt, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) },
      config: { ...config, baseUrl: localOpenAiApiBase(config) }, fetchImpl,
      thinkingModel: selected.thinking, visionModel: selected.vision })
  },
})
