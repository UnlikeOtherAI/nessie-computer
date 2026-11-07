import type {
  LocalInferenceAttemptRequest,
  LocalInferenceResult,
  ModelCapabilitySnapshot,
  ObservedLocalModel,
} from '@nessie/executor-protocol'

import { chatgptNonacceptanceEvidence } from './chatgpt-errors.js'
import { isStructurallyLocalOllamaModel, type ObservedOllamaModel } from './ollama-observed.js'

/**
 * What a host publishes about a local model and says about it in a receipt:
 * documented capability values only, never a model-name heuristic.
 */
export type EligibleModel = ObservedOllamaModel

export const knownCapabilities = (model: ObservedOllamaModel): ObservedLocalModel['capabilities'] => {
  const capabilities = new Set<ObservedLocalModel['capabilities'][number]>()
  // These are documented Ollama capability values, not a model-name heuristic.
  if (model.capabilities.includes('completion')) capabilities.add('text')
  if (model.capabilities.includes('tools')) capabilities.add('tools')
  if (model.capabilities.includes('structured_output')) capabilities.add('json_schema')
  if (model.capabilities.includes('thinking')) capabilities.add('thinking')
  // Both transports deliver admitted inline images to a model that reports it can see them.
  if (model.capabilities.includes('vision')) capabilities.add('vision')
  return [...capabilities]
}

export const publishedModel = (model: ObservedOllamaModel, reportedAt: string): ObservedLocalModel => ({
  ...(model.inferenceSource ? { inferenceSource: model.inferenceSource } : {}),
  ...(model.displayName ? { displayName: model.displayName } : {}),
  ...(model.providerModelId ? { providerModelId: model.providerModelId } : {}),
  ...(model.personalBackgroundConsentRevision !== undefined
    ? { personalBackgroundConsentRevision: model.personalBackgroundConsentRevision } : {}),
  capabilities: knownCapabilities(model),
  ...(model.identitySource ? { identitySource: model.identitySource } : {}),
  manifestDigest: model.manifestDigest,
  name: model.name,
  numCtxCap: model.numCtxCap,
  ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
  ...(model.modelRevision ? { modelRevision: model.modelRevision } : {}),
  remoteHost: model.remoteHost,
  remoteModel: model.remoteModel,
  reportedAt,
  sizeBytes: model.sizeBytes,
})

export const deadlinePassed = (attempt: LocalInferenceAttemptRequest, now: Date): boolean => (
  new Date(attempt.deadlineAt).valueOf() <= now.valueOf()
)

export const matchesSelectedModel = (
  model: ObservedOllamaModel,
  attempt: LocalInferenceAttemptRequest,
): model is EligibleModel => (
  // The local host is not enabled for ChatGPT until its source-aware backend lands.
  attempt.inferenceSource?.kind !== 'chatgpt'
  && model.inferenceSource?.kind !== 'chatgpt'
  && isStructurallyLocalOllamaModel(model)
  && model.name === attempt.modelName
  && model.manifestDigest === attempt.modelDigest
)

export const capabilityFor = (
  attempt: LocalInferenceAttemptRequest,
  model: EligibleModel,
  now: Date,
): ModelCapabilitySnapshot => ({
  discoveredAt: now.toISOString(),
  lastVerifiedAt: now.toISOString(),
  ...(model.numCtxCap === null ? {} : { maxInputTokens: model.numCtxCap }),
  ...((model.maxOutputTokens ?? attempt.maxOutputTokens) === undefined ? {}
    : { maxOutputTokens: model.maxOutputTokens ?? attempt.maxOutputTokens }),
  model: attempt.modelName,
  provider: attempt.inferenceSource?.kind === 'chatgpt' ? 'executor/chatgpt' : 'local_device',
  source: model.identitySource === 'owner_configuration' ? 'manual' as const : 'live' as const,
  structuredOutputMode: knownCapabilities(model).includes('json_schema') ? 'native-json' as const : 'text-only' as const,
  supportsChat: true,
  supportsEmbeddings: false,
  supportsModelDiscovery: true,
  supportsStreaming: true,
  supportsVision: knownCapabilities(model).includes('vision'),
  systemPromptMode: 'native' as const,
  toolCallingMode: knownCapabilities(model).includes('tools') ? 'native' as const : 'disabled' as const,
  toolResultMode: 'native-tool-message' as const,
  usageReporting: {
    cachedInputTokens: false,
    cachedOutputTokens: false,
    cacheReadTokens: false,
    cacheWriteTokens: false,
    inputTokens: true,
    outputTokens: true,
    providerReportedCost: false,
  },
})

export const errorResult = (
  attempt: LocalInferenceAttemptRequest,
  model: EligibleModel,
  now: Date,
  error?: unknown,
): LocalInferenceResult => ({
  ...(attempt.inferenceSource?.kind === 'chatgpt' && chatgptNonacceptanceEvidence(error)
    ? { personalNonacceptance: chatgptNonacceptanceEvidence(error) } : {}),
  ...(attempt.inferenceSource ? { inferenceSource: attempt.inferenceSource } : {}),
  capability: capabilityFor(attempt, model, now),
  content: null,
  finishReason: 'error',
  modelDigest: attempt.modelDigest,
  remoteHost: null,
  remoteModel: null,
  toolCalls: [],
  usage: { inputTokens: null, outputTokens: null },
})
