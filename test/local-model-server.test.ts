import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createLocalModelServerBackend, localModelServerKind } from '../src/local-model-server.js'
import type { OllamaFetch } from '../src/ollama-client.js'
import { parseLocalOpenAiConfig } from '../src/openai-local-config.js'
import type { LocalOpenAiFetch } from '../src/openai-local-observed.js'

const SHA = 'a'.repeat(64)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const at = (baseUrl: string) => parseLocalOpenAiConfig({ baseUrl, localServiceConfirmed: true })

/** Ollama answering wherever it is asked, with one local model. */
const ollama = (requests: string[]): OllamaFetch => async (url) => {
  requests.push(url)
  if (url.endsWith('/api/version')) return json({ version: '0.40.14' })
  if (url.endsWith('/api/tags')) return json({ models: [{ name: 'qwen3.5:4b', digest: SHA, size: 1 }] })
  if (url.endsWith('/api/show')) {
    return json({ capabilities: ['completion', 'vision', 'tools'], details: { format: 'gguf' },
      model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 } })
  }
  return json({ error: 'not found' }, 404)
}
/** A server that is not Ollama: its version endpoint is not there. */
const notOllama = (requests: string[]): OllamaFetch => async (url) => {
  requests.push(url)
  return json({ error: { message: 'not found' } }, 404)
}
const strata = (requests: string[]): LocalOpenAiFetch => async (url) => {
  requests.push(url)
  if (url.endsWith('/models')) {
    return json({ data: [{ id: 'qwen3.8-flash', meta: { n_ctx: 262144 },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }] })
  }
  if (url.endsWith('/props')) {
    return json({ default_generation_settings: { n_ctx: 262144, params: { n_predict: -1 } },
      model_alias: 'qwen3.8-flash', chat_template_caps: { supports_tools: true }, modalities: { vision: true },
      chat_template: '{% if enable_thinking %}{% endif %}' })
  }
  return json({ error: { message: 'not found' } }, 404)
}

test('an address where Ollama answers is served as Ollama, at that port', async () => {
  const requests: string[] = []
  const backend = createLocalModelServerBackend(async () => at('http://127.0.0.1:11500'), {
    ollamaFetch: ollama(requests), openAiFetch: strata(requests),
  })
  const models = await backend.observe()
  assert.deepEqual(models.map((model) => [model.name, model.numCtxCap, model.identitySource]),
    [['qwen3.5:4b', 262144, undefined]])
  assert.ok(requests.every((url) => url.startsWith('http://127.0.0.1:11500/api/')))
  assert.equal(await localModelServerKind(at('http://127.0.0.1:11500'), ollama([])), 'ollama')
})

test('an address where something else answers is read as an OpenAI-compatible server', async () => {
  const requests: string[] = []
  const backend = createLocalModelServerBackend(async () => at('http://127.0.0.1:8080'), {
    ollamaFetch: notOllama(requests), openAiFetch: strata(requests),
  })
  const models = await backend.observe()
  assert.deepEqual(models.map((model) => [model.name, model.numCtxCap, model.capabilities]),
    [['qwen3.8-flash', 262144, ['completion', 'tools', 'thinking', 'vision']]])
  assert.deepEqual(requests, ['http://127.0.0.1:8080/api/version', 'http://127.0.0.1:8080/v1/models',
    'http://127.0.0.1:8080/props'])
  assert.equal(await localModelServerKind(at('http://127.0.0.1:8080'), notOllama([])), 'openai')
})

test('no saved address means Ollama on its own port, without asking what it is', async () => {
  const requests: string[] = []
  const backend = createLocalModelServerBackend(async () => null, {
    ollamaFetch: ollama(requests), openAiFetch: strata(requests),
  })
  assert.equal((await backend.observe()).length, 1)
  assert.ok(requests.every((url) => url.startsWith('http://127.0.0.1:11434/api/')))
  assert.equal(await localModelServerKind(null), 'ollama')
})

test('a server that went away is offline, not mistaken for another kind', async () => {
  const backend = createLocalModelServerBackend(async () => at('http://127.0.0.1:8080'), {
    ollamaFetch: async () => { throw new Error('connection refused') },
    openAiFetch: async () => { throw new Error('connection refused') },
  })
  await assert.rejects(backend.observe(), /endpoint_unavailable/)
})
