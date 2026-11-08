import { randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { assertOwnerOnlyStatePath } from './state-security.js'
import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { acquireOwnerStateLock } from './personal-admission-lock.js'
import { parseLocalOpenAiConfig, readLocalOpenAiConfig, type LocalOpenAiConfig } from './openai-local-config.js'

import { DEFAULT_OLLAMA_ORIGIN } from './ollama-client.js'

const FILE = 'inference-endpoints.json'
export const LEGACY_ENDPOINT_ID = '00000000-0000-4000-8000-000000000001'
export type InferenceEndpoint = { id: string; name: string; config: LocalOpenAiConfig }
export const defaultInferenceEndpoint = (): InferenceEndpoint => ({ id: LEGACY_ENDPOINT_ID, name: 'Ollama',
  config: { baseUrl: DEFAULT_OLLAMA_ORIGIN, localServiceConfirmed: true } })
const Endpoint = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80),
  config: z.unknown().transform(value => parseLocalOpenAiConfig(value)),
}).strict()
const Collection = z.object({ version: z.literal(1), endpoints: z.array(Endpoint).max(32) }).strict()
  .refine(value => new Set(value.endpoints.map(endpoint => endpoint.id)).size === value.endpoints.length)

/** null retains automatic local Ollama discovery; an explicit empty list disables saved endpoints. */
export const readInferenceEndpoints = async (directory: string): Promise<InferenceEndpoint[] | null> => {
  await assertOwnerOnlyStatePath(directory, 'directory')
  const path = join(directory, FILE)
  try { await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const legacy = await readLocalOpenAiConfig(directory)
    return legacy ? [{ id: LEGACY_ENDPOINT_ID, name: new URL(legacy.baseUrl).host, config: legacy }] : null
  }
  await assertOwnerOnlyStatePath(path, 'file')
  const bytes = await readFile(path)
  if (bytes.length > 256 * 1024) throw new Error('endpoint_configuration_invalid')
  return Collection.parse(JSON.parse(bytes.toString('utf8'))).endpoints
}

/** Serialize read-modify-write so two native windows cannot discard each other's connections. */
export const changeInferenceEndpoint = async (directory: string, input:
  | { operation: 'save'; id?: string; name: string; config: LocalOpenAiConfig; preserveApiKey?: boolean }
  | { operation: 'remove'; id: string },
): Promise<string> => {
  await assertOwnerOnlyStatePath(directory, 'directory')
  const lease = await acquireOwnerStateLock(directory, 'inference-endpoints.lock')
  try {
    const endpoints = await readInferenceEndpoints(directory) ?? [defaultInferenceEndpoint()]
    const id = z.string().uuid().parse(input.id ?? randomUUID())
    const existing = endpoints.findIndex(endpoint => endpoint.id === id)
    if (input.operation === 'remove') {
      if (existing >= 0) endpoints.splice(existing, 1)
    } else {
      const previous = endpoints[existing]?.config
      // Resolve omitted credentials under the same lock as the configuration write.
      const apiKey = input.preserveApiKey && previous?.baseUrl === input.config.baseUrl
        ? previous.apiKey : input.config.apiKey
      const config = { ...input.config, ...(apiKey ? { apiKey } : {}) }
      const endpoint = Endpoint.parse({ id, name: input.name, config })
      if (existing >= 0) endpoints[existing] = endpoint
      else endpoints.push(endpoint)
    }
    const next = Collection.parse({ version: 1, endpoints })
    await replaceOwnerOnlyJson(join(directory, FILE), next)
    return id
  } finally { await lease.release() }
}
