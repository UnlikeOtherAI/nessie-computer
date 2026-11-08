import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInferenceEndpointBackend } from '../src/inference-endpoint-backend.js'
import { isInferenceNetworkAddress, resolveInferenceAddresses } from '../src/inference-endpoint-network.js'
import { parseLocalOpenAiConfig } from '../src/openai-local-config.js'
import { LEGACY_ENDPOINT_ID, type InferenceEndpoint } from '../src/inference-endpoints.js'
import type { LocalInferenceBackend, LocalInferenceStreamInput } from '../src/local-inference-backend.js'
import { attempt } from './fixtures/local-inference-host.js'

const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'
const endpoint = (id: string): InferenceEndpoint => ({ id, name: id === first ? 'Strata' : 'Lab',
  config: { baseUrl: 'http://192.168.1.90:8080/v1', networkServiceConfirmed: true } })
const model = { name: 'qwen', manifestDigest: 'a'.repeat(64), capabilities: ['completion'],
  numCtxCap: 8192, remoteHost: null, remoteModel: null, sizeBytes: null }
const input = (name: string, digest: string): LocalInferenceStreamInput => ({
  attempt: { ...attempt(), modelName: name, modelDigest: digest }, origin: '',
  signal: new AbortController().signal, think: false,
})
test('identical model names on different endpoints route only to the selected connection', async () => {
  let endpoints = [endpoint(first), endpoint(second)]
  const dispatched: string[] = []
  const backend = createInferenceEndpointBackend(async () => endpoints, connection => ({
    observe: async () => [model], stream: async function* (request) {
      assert.equal(request.attempt.modelName, 'qwen')
      assert.equal(request.attempt.modelDigest, model.manifestDigest)
      dispatched.push(connection.id)
      yield { done: true, text: connection.name }
    },
  }))
  const models = await backend.observe()
  assert.equal(new Set(models.map(value => value.name)).size, 2)
  assert.equal(new Set(models.map(value => value.manifestDigest)).size, 2)
  for await (const event of backend.stream(input(models[1]!.name, models[1]!.manifestDigest))) {
    assert.equal(event.text, 'Lab')
  }
  assert.deepEqual(dispatched, [second])
  endpoints = [endpoint(first)]
  await assert.rejects(async () => {
    for await (const _event of backend.stream(input(models[1]!.name, models[1]!.manifestDigest))) { /* consume */ }
  }, /endpoint_model_changed/)
  assert.deepEqual(dispatched, [second], 'removal never falls back to another server')
})
test('an offline endpoint does not hide another; address changes fence a previously selected model', async () => {
  const endpoints = [endpoint(first), endpoint(second)]
  const backend = createInferenceEndpointBackend(async () => endpoints, connection => ({
    observe: async () => { if (connection.id === second) throw new Error('offline'); return [model] },
    stream: async function* () { assert.fail('changed endpoint must never receive the request'); yield { done: true } },
  }))
  const observed = await backend.observe()
  assert.equal(observed.length, 1)
  endpoints[0]!.config.baseUrl = 'http://192.168.1.91:8080/v1'
  await assert.rejects(async () => {
    for await (const _event of backend.stream(input(observed[0]!.name, observed[0]!.manifestDigest))) { /* consume */ }
  }, /endpoint_model_changed/)
})
test('legacy model identities stay stable when another server is added', async () => {
  const legacy = { ...endpoint(LEGACY_ENDPOINT_ID), config: {
    baseUrl: 'http://127.0.0.1:8080', localServiceConfirmed: true as const } }
  const backend = createInferenceEndpointBackend(async () => [legacy, endpoint(first)], () => ({
    observe: async () => [model], stream: async function* () { yield { done: true } },
  } satisfies LocalInferenceBackend))
  assert.deepEqual((await backend.observe())[0], model)
})
test('LAN configuration is explicit and every DNS answer stays within the local network', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.90', '::1', 'fd00::1']) {
    assert.equal(isInferenceNetworkAddress(address), true, address)
  }
  for (const address of ['169.254.169.254', '0.0.0.0', '8.8.8.8', '224.0.0.1', '::', '2001:4860::1']) {
    assert.equal(isInferenceNetworkAddress(address), false, address)
  }
  assert.throws(() => parseLocalOpenAiConfig({ baseUrl: 'http://192.168.1.90', localServiceConfirmed: true }))
  assert.equal(parseLocalOpenAiConfig({ baseUrl: 'http://strata.local:8080/v1',
    networkServiceConfirmed: true }).baseUrl, 'http://strata.local:8080/v1')
  assert.deepEqual(await resolveInferenceAddresses('strata.local', async () => ['192.168.1.90']), ['192.168.1.90'])
  await assert.rejects(resolveInferenceAddresses('strata.local', async () => ['192.168.1.90', '8.8.8.8']))
  await assert.rejects(resolveInferenceAddresses('strata.local', async () => []))
  for (const address of ['https://8.8.8.8/v1', 'http://user:pass@strata.local/v1', 'file:///etc/passwd']) {
    assert.throws(() => parseLocalOpenAiConfig({ baseUrl: address, networkServiceConfirmed: true }))
  }
})
