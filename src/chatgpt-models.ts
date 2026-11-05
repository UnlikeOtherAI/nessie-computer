import { createHash } from 'node:crypto'
import { ExecutorInferenceSourceSchema } from '@nessie/executor-protocol'
import type { ObservedInferenceModel } from './local-inference-backend.js'
import type { ChatgptAccessLease, ChatgptInferenceSource } from './chatgpt-auth-provider.js'
import { ChatgptError, chatgptProviderFailure, isRecord } from './chatgpt-errors.js'
import { CHATGPT_MODELS_URL, chatgptFetch, readChatgptJson, type ChatgptFetch } from './chatgpt-http.js'

/** Exact official model metadata, verified 2026-10-13. Never infer alias capacities. */
const VERIFIED_MODELS: Readonly<Record<string, { context: number; output: number; revision: string }>> = {
  'gpt-6.1-sol': { context: 1_050_000, output: 128_000, revision: 'openai-gpt-6.1-sol-2026-10-13' },
}

export type ChatgptModel = ObservedInferenceModel & {
  inferenceSource: ChatgptInferenceSource
  providerModelId: string
  displayName: string
  numCtxCap: number
  maxOutputTokens: number
}

export const chatgptModelName = (source: ChatgptInferenceSource, slug: string): string =>
  `chatgpt/${source.profileId}/${slug}`

export const readChatgptModels = async (
  source: ChatgptInferenceSource, lease: ChatgptAccessLease, fetchImpl: ChatgptFetch = chatgptFetch,
): Promise<{ models: ChatgptModel[]; unsupportedModelIds: string[] }> => {
  const parsed = ExecutorInferenceSourceSchema.safeParse(source)
  if (!parsed.success || parsed.data.kind !== 'chatgpt' || lease.signal.aborted) {
    throw new ChatgptError('chatgpt_unavailable', 'not_sent')
  }
  let response: Response
  try {
    response = await fetchImpl(CHATGPT_MODELS_URL, { method: 'GET', redirect: 'error', signal: lease.signal,
      headers: { Authorization: `Bearer ${lease.accessToken}`, Accept: 'application/json' } })
  } catch { throw new ChatgptError('chatgpt_unavailable', 'not_sent') }
  const body = await readChatgptJson(response)
  if (!response.ok) throw chatgptProviderFailure(body, response.status)
  if (!isRecord(body) || !Array.isArray(body.models) || body.models.length > 100) {
    throw new ChatgptError('chatgpt_protocol_error', 'rejected')
  }
  const models: ChatgptModel[] = []
  const unsupportedModelIds: string[] = []
  const seen = new Set<string>()
  for (const row of body.models) {
    if (!isRecord(row) || typeof row.visibility !== 'string') throw new ChatgptError('chatgpt_protocol_error', 'rejected')
    if (row.visibility !== 'list') continue
    if (typeof row.slug !== 'string' || !row.slug || row.slug.length > 200 || seen.has(row.slug)) {
      throw new ChatgptError('chatgpt_protocol_error', 'rejected')
    }
    seen.add(row.slug)
    const metadata = Object.hasOwn(VERIFIED_MODELS, row.slug) ? VERIFIED_MODELS[row.slug] : undefined
    if (!metadata) { unsupportedModelIds.push(row.slug); continue }
    if (chatgptModelName(source, row.slug).length > 200) { unsupportedModelIds.push(row.slug); continue }
    const displayName = row.display_name === undefined ? row.slug : row.display_name
    if (typeof displayName !== 'string' || !displayName || displayName.length > 200) {
      throw new ChatgptError('chatgpt_protocol_error', 'rejected')
    }
    const manifestDigest = createHash('sha256').update(JSON.stringify({ source: parsed.data,
      slug: row.slug, capacity: metadata, protocol: 'siwc-responses-v1' })).digest('hex')
    models.push({ inferenceSource: parsed.data, providerModelId: row.slug, displayName,
      name: chatgptModelName(source, row.slug), manifestDigest, modelRevision: metadata.revision,
      capabilities: ['completion', 'tools', 'thinking', 'vision'], numCtxCap: metadata.context,
      maxOutputTokens: metadata.output, sizeBytes: null, remoteHost: null, remoteModel: null })
  }
  return { models, unsupportedModelIds }
}
