import { ExecutorInferenceSourceSchema } from '@nessie/executor-protocol'
import type { ChatgptAuthProvider, ChatgptInferenceSource } from './chatgpt-auth-provider.js'
import { sameChatgptSource } from './chatgpt-auth-provider.js'
import type { LocalInferenceBackend } from './local-inference-backend.js'
import { ChatgptError } from './chatgpt-errors.js'
import { type ChatgptFetch } from './chatgpt-http.js'
import { readChatgptModels, type ChatgptModel } from './chatgpt-models.js'
import { chatgptRequestBody } from './chatgpt-request.js'
import { streamChatgptResponse } from './chatgpt-stream.js'

/** The auth consumer is mandatory. No API key, OAuth state or default profile path is accepted here. */
export const createChatgptBackend = (auth: ChatgptAuthProvider, options: {
  fetchImpl?: ChatgptFetch
  onUnavailable?: (source: ChatgptInferenceSource, code: ChatgptError['code']) => void
} = {}): LocalInferenceBackend => {
  let observed = new Map<string, ChatgptModel>()
  const profiles = async (): Promise<ChatgptInferenceSource[]> => {
    const ready = await auth.listReadyProfiles()
    if (ready.length > 100) throw new ChatgptError('chatgpt_protocol_error', 'not_sent')
    const ids = new Set<string>()
    return ready.map((value) => {
      const parsed = ExecutorInferenceSourceSchema.safeParse(value)
      if (!parsed.success || parsed.data.kind !== 'chatgpt' || ids.has(parsed.data.profileId)) {
        throw new ChatgptError('chatgpt_protocol_error', 'not_sent')
      }
      ids.add(parsed.data.profileId)
      return parsed.data
    })
  }
  return {
    observe: async () => {
      const results = await Promise.allSettled((await profiles()).map(async (source) => {
        let lease
        try {
          lease = await auth.acquireAccess({ purpose: 'discovery', source, signal: AbortSignal.timeout(10_000) })
          const inventory = await readChatgptModels(source, lease, options.fetchImpl)
          if (inventory.unsupportedModelIds.length) options.onUnavailable?.(source, 'chatgpt_unsupported_capability')
          const backgroundConsentRevision = await auth.backgroundConsentRevision?.(source) ?? null
          return inventory.models.map(model => ({ ...model,
            personalBackgroundConsentRevision: backgroundConsentRevision }))
        } catch (error) {
          options.onUnavailable?.(source, error instanceof ChatgptError ? error.code : 'chatgpt_unavailable')
          return []
        } finally { await lease?.release() }
      }))
      const current = await profiles()
      const models = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
        .filter((model) => current.some((source) => sameChatgptSource(source, model.inferenceSource)))
      observed = new Map(models.map((model) => [model.name, model]))
      return models
    },
    stream: async function* (input) {
      const source = input.attempt.inferenceSource
      if (source?.kind !== 'chatgpt') throw new ChatgptError('chatgpt_policy_denied', 'not_sent')
      const model = observed.get(input.attempt.modelName)
      if (!model || model.manifestDigest !== input.attempt.modelDigest
        || !sameChatgptSource(source, model.inferenceSource)) {
        throw new ChatgptError('chatgpt_model_missing', 'not_sent')
      }
      // Required caps refuse before resolving any credential or spending a request.
      chatgptRequestBody(input.attempt, model)
      const ready = await profiles()
      if (!ready.some((candidate) => sameChatgptSource(source, candidate))) {
        throw new ChatgptError('chatgpt_needs_sign_in', 'not_sent')
      }
      const lease = await auth.acquireAccess({ purpose: 'inference', source,
        signal: input.signal, attempt: input.attempt })
      let generationStarted = false
      try {
        const inventory = await readChatgptModels(source, lease, options.fetchImpl)
        const live = inventory.models.find((candidate) => candidate.manifestDigest === model.manifestDigest
          && candidate.providerModelId === model.providerModelId && candidate.name === model.name)
        if (!live) throw new ChatgptError('chatgpt_model_missing', 'not_sent')
        generationStarted = true
        yield* streamChatgptResponse({ ...input, model: live, lease, fetchImpl: options.fetchImpl })
      } catch (error) {
        if (!generationStarted) {
          throw new ChatgptError(error instanceof ChatgptError ? error.code : 'chatgpt_unavailable', 'not_sent')
        }
        throw error
      } finally { await lease.release() }
    },
  }
}
