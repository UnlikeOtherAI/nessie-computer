import { createOllamaBackend, type LocalInferenceBackend } from './local-inference-backend.js'
import { DEFAULT_OLLAMA_ORIGIN, defaultOllamaFetch, detectOllama, type OllamaFetch } from './ollama-client.js'
import { localModelServerOrigin, type LocalOpenAiConfig } from './openai-local-config.js'
import { createLocalOpenAiBackend, localOpenAiFetch, type LocalOpenAiFetch } from './openai-local-observed.js'

/**
 * The executor serves whatever model server listens where its owner pointed it.
 * With no address saved that is Ollama on its own port. A saved address is
 * asked what it is on every observation and invocation: Ollama answers its
 * version endpoint, and anything else is read as an OpenAI-compatible server
 * that describes its own models. Swapping one server for another on the same
 * port needs no reconfiguration; the changed model identity fences old pins.
 */
export const createLocalModelServerBackend = (
  readConfig: () => Promise<LocalOpenAiConfig | null>,
  options: { ollamaFetch?: OllamaFetch; openAiFetch?: LocalOpenAiFetch } = {},
): LocalInferenceBackend => {
  const ollamaFetch = options.ollamaFetch ?? defaultOllamaFetch
  const ollamaAt = (origin: string) =>
    createOllamaBackend(origin, options.ollamaFetch ? { fetchImpl: options.ollamaFetch } : {})
  const openai = createLocalOpenAiBackend(readConfig, options.openAiFetch ?? localOpenAiFetch)
  const current = async (): Promise<LocalInferenceBackend> => {
    const config = await readConfig()
    if (!config) return ollamaAt(DEFAULT_OLLAMA_ORIGIN)
    const origin = localModelServerOrigin(config)
    const ollama = await detectOllama(origin, ollamaFetch)
    return ollama.available || ollama.reason === 'too_old' ? ollamaAt(origin) : openai
  }
  return {
    observe: async () => (await current()).observe(),
    stream: async function* (input) { yield* (await current()).stream(input) },
  }
}

/** What answers at the owner's address, for the local status command. */
export const localModelServerKind = async (
  config: LocalOpenAiConfig | null, ollamaFetch: OllamaFetch = defaultOllamaFetch,
): Promise<'ollama' | 'openai'> => {
  if (!config) return 'ollama'
  const ollama = await detectOllama(localModelServerOrigin(config), ollamaFetch)
  return ollama.available || ollama.reason === 'too_old' ? 'ollama' : 'openai'
}
