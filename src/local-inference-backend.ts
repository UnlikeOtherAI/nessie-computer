import type {
  ExecutorInferenceSource, LocalCliEngine, LocalCliEngineState, LocalInferenceAttemptRequest,
} from '@nessie/executor-protocol'
import type { OllamaChatEvent } from './ollama-chat.js'
import { streamOllamaChat } from './ollama-chat.js'
import { observeOllamaInventory } from './ollama-observed.js'
import { ChatgptError } from './chatgpt-errors.js'
import { meetsVersionFloor, type OllamaFetch } from './ollama-client.js'

/** Provider-independent observation consumed by the one signed host loop. */
export type ObservedInferenceModel = {
  inferenceSource?: ExecutorInferenceSource
  personalBackgroundConsentRevision?: number | null
  displayName?: string
  providerModelId?: string
  capabilities: string[]
  identitySource?: 'owner_configuration'
  /** A Claude Code or Codex engine on a `local_cli` host (docs/local-cli-engines.md). */
  cliEngine?: LocalCliEngine
  cliEngineState?: LocalCliEngineState
  manifestDigest: string
  name: string
  numCtxCap: number | null
  maxOutputTokens?: number
  modelRevision?: string
  remoteHost: string | null
  remoteModel: string | null
  sizeBytes: number | null
}

export type LocalInferenceStreamInput = {
  attempt: LocalInferenceAttemptRequest
  origin: string
  signal: AbortSignal
  think: boolean
  /** Preserve the owner's Ollama context configuration instead of allocating its architectural maximum. */
  useModelDefaultContext?: true
}

export type LocalInferenceBackend = {
  observe: () => Promise<ObservedInferenceModel[]>
  stream: (input: LocalInferenceStreamInput) => AsyncGenerator<OllamaChatEvent>
}

export const createOllamaBackend = (origin: string, options: {
  /** v0.40.0 implements both truncate:false and shift:false, including its native chat renderer. */
  requireUntruncatedContext?: true
  fetchImpl?: OllamaFetch
} = {}): LocalInferenceBackend => ({
  observe: async () => {
    const inventory = await observeOllamaInventory(origin, options.fetchImpl)
    if (options.requireUntruncatedContext && !meetsVersionFloor(inventory.version, '0.40.0')) {
      throw new Error('Ollama 0.40.0 or later is required to prevent context truncation.')
    }
    return inventory.models
  },
  stream: (input) => streamOllamaChat({ ...input, origin,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.requireUntruncatedContext ? { preventContextLoss: true as const } : {}),
  }),
})

/** Discovery failures are independent; dispatch always follows the explicit source. */
export const composeInferenceBackends = (
  local: LocalInferenceBackend, chatgpt: LocalInferenceBackend,
): LocalInferenceBackend => ({
  observe: async () => {
    const results = await Promise.allSettled([local.observe(), chatgpt.observe()])
    const models = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    if (models.length > 100 || new Set(models.map((model) => model.name)).size !== models.length) {
      throw new Error('Inference inventory identity or capacity needs repair.')
    }
    return models
  },
  stream: async function* (input) {
    if (input.attempt.inferenceSource?.kind === 'chatgpt') yield* chatgpt.stream(input)
    else if (input.attempt.inferenceSource === undefined || input.attempt.inferenceSource.kind === 'local_weights') {
      yield* local.stream(input)
    } else throw new ChatgptError('chatgpt_policy_denied', 'not_sent')
  },
})
