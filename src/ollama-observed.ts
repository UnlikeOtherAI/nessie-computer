import {
  DEFAULT_OLLAMA_ORIGIN,
  assertLoopbackOrigin,
  defaultOllamaFetch,
  type OllamaFetch,
} from './ollama-client.js'
import {
  ollamaObservationFingerprints,
  resolveOllamaLoopbackEndpoint,
} from '@nessie/local-inference-host'

/**
 * Read-only observation of a person's installed Ollama inventory.  This must
 * stay separate from the curated importer: it neither pulls, creates, nor
 * edits a model.  Locality is structural; a loopback address or a friendly
 * tag is never sufficient evidence.
 */
export type ObservedOllamaModel = import('./local-inference-backend.js').ObservedInferenceModel

export type OllamaInventory = {
  models: ObservedOllamaModel[]
  origin: string
  version: string
}

export class OllamaObservationError extends Error {
  override readonly name = 'OllamaObservationError'
}

const MAX_JSON_BYTES = 256 * 1024
const MODEL_NAME_MAX = 200
const SHA256 = /^[a-f0-9]{64}$/

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const boundedText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max
    ? value.normalize('NFC')
    : null

const remoteMarker = (value: unknown): string | null =>
  value === undefined || value === null || value === '' ? null : boundedText(value, 512)

/**
 * Ollama's cloud-routing fields are a structural locality signal. The chat
 * transport calls this for every streamed object; discovery alone is not a
 * sufficient check because a locally mutable tag can change between the
 * inventory sweep and a request.
 */
export const assertNoRemoteOllamaMarker = (result: unknown): void => {
  const body = asRecord(result)
  if (remoteMarker(body?.remote_host) !== null || remoteMarker(body?.remote_model) !== null) {
    throw new OllamaObservationError('Ollama result is not local')
  }
}

const responseJson = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new OllamaObservationError(`Ollama returned HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new OllamaObservationError('Ollama inventory response exceeds the safety bound')
  }
  const text = await response.text()
  if (text.length > MAX_JSON_BYTES) {
    throw new OllamaObservationError('Ollama inventory response exceeds the safety bound')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new OllamaObservationError('Ollama returned malformed JSON')
  }
}

const modelFrom = (tag: Record<string, unknown>, show: Record<string, unknown>): ObservedOllamaModel | null => {
  const name = boundedText(tag.name, MODEL_NAME_MAX)
  const digest = boundedText(tag.digest, 64)?.toLowerCase()
  const details = asRecord(show.details)
  const modelInfo = asRecord(show.model_info)
  if (!name || !digest || !SHA256.test(digest) || !details || !modelInfo) return null
  const capabilities = Array.isArray(show.capabilities)
    ? show.capabilities
      .map((value) => boundedText(value, 64))
      .filter((value): value is string => value !== null)
      .slice(0, 16)
    : []
  const architecture = boundedText(modelInfo['general.architecture'], 64)
  const architectureContext = architecture && /^[A-Za-z0-9_]+$/u.test(architecture)
    ? modelInfo[`${architecture}.context_length`] : undefined
  const numCtxRaw = modelInfo['general.context_length'] ?? architectureContext
  const numCtxCap = typeof numCtxRaw === 'number' && Number.isSafeInteger(numCtxRaw) && numCtxRaw > 0
    ? numCtxRaw
    : null
  const sizeBytes = typeof tag.size === 'number' && Number.isSafeInteger(tag.size) && tag.size >= 0
    ? tag.size
    : null
  const remoteHost = remoteMarker(tag.remote_host) ?? remoteMarker(show.remote_host)
  const remoteModel = remoteMarker(tag.remote_model) ?? remoteMarker(show.remote_model)
  return { capabilities, manifestDigest: digest, name, numCtxCap, remoteHost, remoteModel, sizeBytes }
}

/** A model can only be selected after independent tags + show evidence. */
export const isStructurallyLocalOllamaModel = (model: ObservedOllamaModel): boolean =>
  model.remoteHost === null
  && model.remoteModel === null
  && SHA256.test(model.manifestDigest)
  && model.capabilities.length > 0

export const observeOllamaInventory = async (
  origin: string = DEFAULT_OLLAMA_ORIGIN,
  fetchImpl: OllamaFetch = defaultOllamaFetch,
): Promise<OllamaInventory> => {
  const base = assertLoopbackOrigin(origin)
  const version = asRecord(await responseJson(await fetchImpl(`${base}/api/version`, {
    signal: AbortSignal.timeout(2_000),
  })))
  const versionText = boundedText(version?.version, 40)
  if (!versionText) throw new OllamaObservationError('Ollama did not report a version')
  const tags = asRecord(await responseJson(await fetchImpl(`${base}/api/tags`, {
    signal: AbortSignal.timeout(2_000),
  })))
  if (!Array.isArray(tags?.models) || tags.models.length > 100) {
    throw new OllamaObservationError('Ollama returned an invalid model inventory')
  }
  const models: ObservedOllamaModel[] = []
  for (const entry of tags.models) {
    const tag = asRecord(entry)
    const name = boundedText(tag?.name, MODEL_NAME_MAX)
    if (!tag || !name) continue
    const show = asRecord(await responseJson(await fetchImpl(`${base}/api/show`, {
      body: JSON.stringify({ model: name }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(2_000),
    })))
    if (!show) continue
    const model = modelFrom(tag, show)
    if (model) models.push(model)
  }
  return { models, origin: base, version: versionText }
}

/**
 * The host never scans ports or resolves names.  It tries the reviewed
 * literal-loopback candidates once and refuses to guess when they describe
 * different daemons/model sets.  This is shared by the executor and Desktop
 * direct runtime so their discovery privacy boundary cannot drift.
 */
export const discoverOllamaInventory = async (
  savedOrigin?: string | null,
  fetchImpl: OllamaFetch = defaultOllamaFetch,
): Promise<OllamaInventory> => {
  const candidates = savedOrigin === undefined || savedOrigin === null
    ? [DEFAULT_OLLAMA_ORIGIN, 'http://[::1]:11434']
    : [assertLoopbackOrigin(savedOrigin), DEFAULT_OLLAMA_ORIGIN, 'http://[::1]:11434']
  const unique = [...new Set(candidates)]
  const observed = await Promise.all(unique.map(async (origin) => {
    try {
      const inventory = await observeOllamaInventory(origin, fetchImpl)
      const fingerprints = ollamaObservationFingerprints({
        modelManifestDigests: inventory.models.map((model) => model.manifestDigest),
        version: inventory.version,
      })
      return { ...fingerprints, inventory, origin }
    } catch {
      return undefined
    }
  }))
  const evidence = observed.flatMap((value) => value === undefined ? [] : [{
    daemonFingerprint: value.daemonFingerprint,
    modelSetFingerprint: value.modelSetFingerprint,
    origin: value.origin,
  }])
  const resolved = resolveOllamaLoopbackEndpoint({ evidence, savedOrigin })
  if (resolved.kind !== 'selected') throw new OllamaObservationError('Ollama endpoint could not be resolved')
  const selected = observed.find((value) => value?.origin === resolved.canonicalSocket)
  if (!selected) throw new OllamaObservationError('Ollama endpoint could not be resolved')
  return selected.inventory
}

/** Remote markers are also mandatory at output time, not discovery-only. */
export const assertLocalOllamaResult = (result: unknown, expectedDigest: string): void => {
  const body = asRecord(result)
  const digest = boundedText(body?.digest, 64)?.toLowerCase()
  assertNoRemoteOllamaMarker(result)
  if (digest !== expectedDigest) {
    throw new OllamaObservationError('Ollama result is not the consented local model')
  }
}
