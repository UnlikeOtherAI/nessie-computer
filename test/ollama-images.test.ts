import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocalInferenceAttemptRequest, ProviderMessage } from '@nessie/executor-protocol'
import { knownCapabilities } from '../src/local-inference-host-model.js'
import { streamOllamaChat } from '../src/ollama-chat.js'

const id = '00000000-0000-4000-8000-000000000001'
const PNG = 'iVBORw0KGgo='

const attemptWith = (messages: ProviderMessage[]): LocalInferenceAttemptRequest => ({
  attemptId: id, bindingId: id, bindingRevision: 1, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  hostEpoch: 1, hostId: id, invocationId: 'images', modelDigest: 'a'.repeat(64), modelName: 'gemma3:12b',
  numCtx: 131_072, protocolVersion: 1, runFence: 'test-fence', runId: id, messages, tools: [],
})

const send = async (attempt: LocalInferenceAttemptRequest) => {
  let body: Record<string, unknown> | undefined
  for await (const event of streamOllamaChat({
    attempt, origin: 'http://127.0.0.1:11434', signal: new AbortController().signal, think: false,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(`${JSON.stringify({
        done: true, done_reason: 'stop', model: 'gemma3:12b', message: { content: 'A red square.' },
      })}\n`)
    },
  })) void event
  return body
}

test('Ollama receives a person\'s admitted image bytes as base64 beside their text, at the full context', async () => {
  const body = await send(attemptWith([
    { role: 'system', content: 'Describe what you see.' },
    { role: 'user', content: [{ type: 'text', text: 'What is this?' },
      { type: 'image', imageUrl: `data:image/png;base64,${PNG}` }] },
  ]))
  assert.deepEqual(body?.messages, [
    { role: 'system', content: 'Describe what you see.' },
    { role: 'user', content: 'What is this?', images: [PNG] },
  ])
  assert.equal((body?.options as { num_ctx?: number }).num_ctx, 131_072)
  assert.equal('tools' in (body ?? {}), false, 'a request without tools sends none')
})

test('Ollama never relays a URL for the model server to fetch, nor an image outside a person\'s message', async () => {
  await assert.rejects(send(attemptWith([{ role: 'user', content: [{ type: 'text', text: 'Look' },
    { type: 'image', imageUrl: 'https://example.invalid/cat.png' }] }])), /unsupported_capability/u)
  await assert.rejects(send(attemptWith([{ role: 'assistant', content: [{ type: 'text', text: 'Here' },
    { type: 'image', imageUrl: `data:image/png;base64,${PNG}` }] }])), /unsupported_capability/u)
})

test('an Ollama model that reports vision is published with it', () => {
  const observed = { capabilities: ['completion', 'tools', 'vision'], manifestDigest: 'a'.repeat(64),
    name: 'gemma3:12b', numCtxCap: 131_072, remoteHost: null, remoteModel: null, sizeBytes: 1 }
  assert.deepEqual(knownCapabilities(observed), ['text', 'tools', 'vision'])
})
