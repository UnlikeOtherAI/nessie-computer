import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OllamaObservationError,
  assertLocalOllamaResult,
  isStructurallyLocalOllamaModel,
  observeOllamaInventory,
} from '../src/ollama-observed.js'
import type { OllamaFetch } from '../src/ollama-client.js'
import { createOllamaBackend } from '../src/local-inference-backend.js'

const DIGEST = 'a'.repeat(64)

const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' },
})

const inventoryFetch = (remote = false): OllamaFetch => (url) => {
  if (url.endsWith('/api/version')) return Promise.resolve(json({ version: '0.34.1' }))
  if (url.endsWith('/api/tags')) {
    return Promise.resolve(json({ models: [{
      digest: DIGEST,
      name: remote ? 'looks-local:latest' : 'local:latest',
      ...(remote ? { remote_host: 'cloud.ollama.com' } : {}),
      size: 123,
    }] }))
  }
  return Promise.resolve(json({
    capabilities: ['completion', 'tools'],
    details: { family: 'gemma' },
    model_info: { 'general.context_length': 8192 },
    ...(remote ? { remote_model: 'gemma3:cloud' } : {}),
  }))
}

test('observes installed models through tags and show without mutating Ollama', async () => {
  const inventory = await observeOllamaInventory(undefined, inventoryFetch())
  assert.equal(inventory.models.length, 1)
  const [model] = inventory.models
  assert.ok(model)
  assert.equal(model.manifestDigest, DIGEST)
  assert.equal(model.remoteHost, null)
  assert.equal(model.remoteModel, null)
  assert.equal(isStructurallyLocalOllamaModel(model), true)
})

test('a cloud marker wins over a friendly local-looking model name', async () => {
  const inventory = await observeOllamaInventory(undefined, inventoryFetch(true))
  const [model] = inventory.models
  assert.ok(model)
  assert.equal(model.name, 'looks-local:latest')
  assert.equal(isStructurallyLocalOllamaModel(model), false)
})

test('architectural context capacity follows the model declared by real Ollama metadata', async () => {
  const observe = (modelInfo: Record<string, unknown>) => observeOllamaInventory(undefined, async (url, init) => {
    if (!url.endsWith('/api/show')) return inventoryFetch()(url, init)
    return json({ capabilities: ['completion', 'tools'], details: { family: 'qwen35' }, model_info: modelInfo })
  })
  const real = await observe({ 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 })
  assert.equal(real.models[0]?.numCtxCap, 262144)
  const general = await observe({ 'general.context_length': 8192,
    'general.architecture': 'qwen35', 'qwen35.context_length': 262144 })
  assert.equal(general.models[0]?.numCtxCap, 8192)
  for (const modelInfo of [
    { 'general.architecture': 'different', 'qwen35.context_length': 262144 },
    { 'general.architecture': 'qwen35', 'qwen35.context_length': '262144' },
  ]) assert.equal((await observe(modelInfo)).models[0]?.numCtxCap, null)
})

test('DeepTest context protection refuses older Ollama while ordinary host discovery stays compatible', async () => {
  const origin = 'http://127.0.0.1:11434'
  await assert.rejects(createOllamaBackend(origin, {
    requireUntruncatedContext: true, fetchImpl: inventoryFetch(),
  }).observe(), /0\.40\.0/u)
  assert.equal((await createOllamaBackend(origin, { fetchImpl: inventoryFetch() }).observe()).length, 1)
  const modern: OllamaFetch = (url, init) => url.endsWith('/api/version')
    ? Promise.resolve(json({ version: '0.40.0' })) : inventoryFetch()(url, init)
  assert.equal((await createOllamaBackend(origin, {
    requireUntruncatedContext: true, fetchImpl: modern,
  }).observe()).length, 1)
})

test('a result with any remote marker or changed digest is refused before acceptance', () => {
  assert.doesNotThrow(() => assertLocalOllamaResult({ digest: DIGEST }, DIGEST))
  assert.throws(
    () => assertLocalOllamaResult({ digest: DIGEST, remote_model: 'cloud' }, DIGEST),
    OllamaObservationError,
  )
  assert.throws(
    () => assertLocalOllamaResult({ digest: 'b'.repeat(64) }, DIGEST),
    OllamaObservationError,
  )
})

test('a malformed or oversized inventory fails closed rather than becoming an empty list', async () => {
  await assert.rejects(
    () => observeOllamaInventory(undefined, () => Promise.resolve(new Response('not-json'))),
    OllamaObservationError,
  )
})

test('context is the model\'s own limit, or the owner\'s Ollama num_ctx when lower, within the protocol bound', async () => {
  const observe = async (show: Record<string, unknown>) => (await observeOllamaInventory(undefined,
    async (url, init) => url.endsWith('/api/show')
      ? json({ capabilities: ['completion'], details: { family: 'gemma4' }, ...show })
      : inventoryFetch()(url, init))).models[0]?.numCtxCap
  const gemma = { model_info: { 'general.architecture': 'gemma4', 'gemma4.context_length': 262_144 } }
  assert.equal(await observe(gemma), 262_144)
  assert.equal(await observe({ ...gemma, parameters: 'stop "<eos>"\nnum_ctx 32768\ntemperature 1' }), 32_768)
  assert.equal(await observe({ ...gemma, parameters: 'num_ctx 999999' }), 262_144, 'never above the model')
  assert.equal(await observe({ model_info: {}, parameters: 'num_ctx 16384' }), 16_384)
  assert.equal(await observe({ model_info: {} }), null, 'unknown stays unknown, for the owner to enter')
  assert.equal(await observe({ model_info: { 'general.context_length': 10_000_000 } }), 1_000_000)
})
