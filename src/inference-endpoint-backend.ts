import { createHash } from 'node:crypto'
import type { LocalInferenceBackend, ObservedInferenceModel } from './local-inference-backend.js'
import { createLocalModelServerBackend } from './local-model-server.js'
import { LEGACY_ENDPOINT_ID, type InferenceEndpoint } from './inference-endpoints.js'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const scopedModel = (endpoint: InferenceEndpoint, model: ObservedInferenceModel): ObservedInferenceModel =>
  endpoint.id === LEGACY_ENDPOINT_ID ? model : ({
  ...model, name: `endpoint:${endpoint.id}:${digest(model.name)}`,
  displayName: `${endpoint.name} · ${model.displayName ?? model.name}`,
  providerModelId: model.providerModelId ?? model.name,
  manifestDigest: digest([endpoint.id, endpoint.config.baseUrl, model.manifestDigest]),
})
const backendFor = (endpoint: InferenceEndpoint): LocalInferenceBackend =>
  createLocalModelServerBackend(async () => endpoint.config)

/** One signed host advertises distinct endpoint models; one unavailable server cannot hide another. */
export const createInferenceEndpointBackend = (
  read: () => Promise<InferenceEndpoint[] | null>,
  backend: (endpoint: InferenceEndpoint) => LocalInferenceBackend = backendFor,
): LocalInferenceBackend => ({
  observe: async () => {
    const endpoints = await read()
    if (endpoints === null) return createLocalModelServerBackend(async () => null).observe()
    const results = await Promise.allSettled(endpoints.map(async endpoint =>
      (await backend(endpoint).observe()).map(model => scopedModel(endpoint, model))))
    const models = results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
    if (models.length > 100) throw new Error('endpoint_inventory_capacity_exceeded')
    return models
  },
  stream: async function* (input) {
    const endpoints = await read()
    if (endpoints === null) {
      yield* createLocalModelServerBackend(async () => null).stream(input)
      return
    }
    const endpoint = endpoints.find(item => item.id === LEGACY_ENDPOINT_ID
      ? !input.attempt.modelName.startsWith('endpoint:')
      : input.attempt.modelName.startsWith(`endpoint:${item.id}:`))
    if (!endpoint) throw new Error('endpoint_model_changed')
    const selected = backend(endpoint)
    const model = (await selected.observe()).find(item => {
      const scoped = scopedModel(endpoint, item)
      return scoped.name === input.attempt.modelName && scoped.manifestDigest === input.attempt.modelDigest
    })
    if (!model) throw new Error('endpoint_model_changed')
    yield* selected.stream({ ...input, attempt: { ...input.attempt,
      modelName: model.name, modelDigest: model.manifestDigest } })
  },
})
