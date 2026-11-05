import { z } from 'zod'

/**
 * The models a person may run on their own machine, and the bytes that are
 * those models.
 *
 * This catalogue is a code constant rather than a document an executor
 * fetches, and that is the whole security property: **the pin is a digest in
 * code, a URL is only how you ask for it, and `latest` is unrepresentable.**
 * The server may ask an executor to pull `gemma4-e4b-q4`; it can no more name
 * the bytes behind that id than it can name an MCP server to run. An executor
 * derives the object key from its own compiled copy of this list and the host
 * from its own reviewed policy.
 *
 * Nessie hosts no inference. It hosts bytes: each entry below is mirrored in
 * an R2 bucket we own, under a key that contains the digest, so a different
 * build cannot reuse a key and a retired model's bytes never vanish from
 * under an executor that is mid-download.
 */

/** A sha256 written the one way the rest of this file may assume. */
const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex sha256')

/**
 * One mirrored file. `bytes` is the exact object length, which is what makes
 * `Range` resume checkable — a `206` whose total is not this is a different
 * object, and the download is refused before a byte is written.
 */
export const LocalModelFileSchema = z.object({
  /** R2 object key. The URL is `<weightsBaseUrl>/<key>`; the digest is in the path. */
  key: z.string().min(1),
  sha256: Sha256Schema,
  bytes: z.number().int().positive(),
  /** Provenance only. Recorded so a reviewer can re-derive the digest; never fetched. */
  upstream: z.string().min(1),
})
export type LocalModelFile = z.infer<typeof LocalModelFileSchema>

export const LocalModelIdSchema = z.enum([
  'gemma4-e2b-q4',
  'gemma4-e2b-q8',
  'gemma4-e4b-q4',
  'gemma4-e4b-q8',
])
export type LocalModelId = z.infer<typeof LocalModelIdSchema>

export const LocalModelEntrySchema = z.object({
  id: LocalModelIdSchema,
  displayName: z.string().min(1),
  size: z.enum(['e2b', 'e4b']),
  quantization: z.enum(['q4_0', 'q8_0']),
  weights: LocalModelFileSchema,
  /**
   * The multimodal projector. Mirrored for the QAT builds because it ships
   * beside them upstream, but nothing reads it yet — vision and audio arrive
   * as capabilities only once there is a delegation that wants them.
   */
  projector: LocalModelFileSchema.optional(),
  /**
   * The model the executor creates locally, namespaced so it cannot collide
   * with one the person pulled themselves.
   */
  ollama: z.object({ name: z.string().min(1) }),
  contextWindow: z.number().int().positive(),
  /**
   * What a delegation actually requests. A full context window would price
   * most laptops out of the feature.
   */
  defaultNumCtx: z.number().int().positive(),
  ramPlanningGB: z.object({
    minimum: z.number().positive(),
    recommended: z.number().positive(),
  }),
  platforms: z.array(z.enum(['macos', 'linux', 'windows'])).nonempty(),
  capabilities: z.array(z.enum(['text', 'tools', 'json_schema'])).nonempty(),
  quality: z.enum(['default', 'higher']),
  /**
   * Bumped whenever a digest changes. A new build is a new object under a new
   * key, never an overwrite.
   */
  revision: z.number().int().positive(),
})
export type LocalModelEntry = z.infer<typeof LocalModelEntrySchema>

/**
 * Where the mirror lives by default.
 *
 * Overridable only in the reviewed local policy (`localInference.weightsBaseUrl`),
 * never by the server and never by a delegation. A self-hosted org that mirrors
 * the bucket keeps the key layout below as the contract.
 */
export const DEFAULT_LOCAL_WEIGHTS_BASE_URL = 'https://models.nessie.works'

const objectKey = (
  size: LocalModelEntry['size'],
  quantization: LocalModelEntry['quantization'],
  sha256: string,
  file: string,
): string => `gemma4/${size}/${quantization}/${sha256}/${file}`

/**
 * RAM figures are planning values pending the phase-0 measurement described in
 * `docs/plans/2026-09-18-local-llm-offload.md` (`ollama ps` at `defaultNumCtx`
 * on an M-series Mac, a CUDA Windows laptop and a CPU-only Linux VM). They are
 * deliberately the conservative reading: a machine that only just clears the
 * minimum runs this model and nothing else large.
 *
 * `capabilities` declares `tools`, which phase 0 also scores — Gemma 4's
 * tool-calling reliability through Ollama's `tools` parameter is not yet
 * measured, and the delegation loop depends on it.
 */
const CATALOGUE: readonly LocalModelEntry[] = [
  {
    id: 'gemma4-e2b-q4',
    displayName: 'Gemma 4 E2B (Q4)',
    size: 'e2b',
    quantization: 'q4_0',
    weights: {
      key: objectKey(
        'e2b',
        'q4_0',
        'fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634',
        'gemma-4-E2B_q4_0-it.gguf',
      ),
      sha256: 'fa401b55b07ee70a54c6dae3903c783a6e65064312529ea57175cb5f8dec6634',
      bytes: 3_349_516_256,
      upstream: 'hf:google/gemma-4-E2B-it-qat-q4_0-gguf',
    },
    projector: {
      key: objectKey(
        'e2b',
        'q4_0',
        '021059cce659fe7f9170d5599761d7bbaf644b798dab9503aca30dc43e6beb14',
        'gemma-4-E2B-it-mmproj.gguf',
      ),
      sha256: '021059cce659fe7f9170d5599761d7bbaf644b798dab9503aca30dc43e6beb14',
      bytes: 986_833_664,
      upstream: 'hf:google/gemma-4-E2B-it-qat-q4_0-gguf',
    },
    ollama: { name: 'nessie/gemma4-e2b-q4' },
    contextWindow: 131_072,
    defaultNumCtx: 8_192,
    ramPlanningGB: { minimum: 16, recommended: 16 },
    platforms: ['macos', 'linux', 'windows'],
    capabilities: ['text', 'tools', 'json_schema'],
    quality: 'default',
    revision: 1,
  },
  {
    id: 'gemma4-e4b-q4',
    displayName: 'Gemma 4 E4B (Q4)',
    size: 'e4b',
    quantization: 'q4_0',
    weights: {
      key: objectKey(
        'e4b',
        'q4_0',
        '676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee',
        'gemma-4-E4B_q4_0-it.gguf',
      ),
      sha256: '676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee',
      bytes: 5_154_941_280,
      upstream: 'hf:google/gemma-4-E4B-it-qat-q4_0-gguf',
    },
    projector: {
      key: objectKey(
        'e4b',
        'q4_0',
        '7498a37cb619e55f2fcf87eb931f56e99389ed6d432e4c5c66110694c0d65578',
        'gemma-4-E4B-it-mmproj.gguf',
      ),
      sha256: '7498a37cb619e55f2fcf87eb931f56e99389ed6d432e4c5c66110694c0d65578',
      bytes: 991_552_256,
      upstream: 'hf:google/gemma-4-E4B-it-qat-q4_0-gguf',
    },
    ollama: { name: 'nessie/gemma4-e4b-q4' },
    contextWindow: 131_072,
    defaultNumCtx: 8_192,
    ramPlanningGB: { minimum: 16, recommended: 24 },
    platforms: ['macos', 'linux', 'windows'],
    capabilities: ['text', 'tools', 'json_schema'],
    quality: 'default',
    revision: 1,
  },
  {
    id: 'gemma4-e2b-q8',
    displayName: 'Gemma 4 E2B (Q8)',
    size: 'e2b',
    quantization: 'q8_0',
    weights: {
      key: objectKey(
        'e2b',
        'q8_0',
        'bb145c0e8c2ede3b6992b881f7eefe6b33275eeb9998f450b5c72f4eb1d78732',
        'google_gemma-4-E2B-it-Q8_0.gguf',
      ),
      sha256: 'bb145c0e8c2ede3b6992b881f7eefe6b33275eeb9998f450b5c72f4eb1d78732',
      bytes: 4_967_497_184,
      upstream: 'hf:bartowski/google_gemma-4-E2B-it-GGUF',
    },
    ollama: { name: 'nessie/gemma4-e2b-q8' },
    contextWindow: 131_072,
    defaultNumCtx: 8_192,
    ramPlanningGB: { minimum: 16, recommended: 24 },
    platforms: ['macos', 'linux', 'windows'],
    capabilities: ['text', 'tools', 'json_schema'],
    quality: 'higher',
    revision: 1,
  },
  {
    id: 'gemma4-e4b-q8',
    displayName: 'Gemma 4 E4B (Q8)',
    size: 'e4b',
    quantization: 'q8_0',
    weights: {
      key: objectKey(
        'e4b',
        'q8_0',
        '6a6eba0d36a051b5d924211a889c1436717006e7c5d413830c47caa1d46cb598',
        'google_gemma-4-E4B-it-Q8_0.gguf',
      ),
      sha256: '6a6eba0d36a051b5d924211a889c1436717006e7c5d413830c47caa1d46cb598',
      bytes: 8_031_242_720,
      upstream: 'hf:bartowski/google_gemma-4-E4B-it-GGUF',
    },
    ollama: { name: 'nessie/gemma4-e4b-q8' },
    contextWindow: 131_072,
    defaultNumCtx: 8_192,
    ramPlanningGB: { minimum: 32, recommended: 32 },
    platforms: ['macos', 'linux', 'windows'],
    capabilities: ['text', 'tools', 'json_schema'],
    quality: 'higher',
    revision: 1,
  },
]

export const listLocalModels = (): LocalModelEntry[] =>
  CATALOGUE.map((entry) => structuredClone(entry))

export const findLocalModel = (id: string): LocalModelEntry | undefined => {
  const entry = CATALOGUE.find((candidate) => candidate.id === id)
  return entry === undefined ? undefined : structuredClone(entry)
}

/** Every file this catalogue would ever ask an executor to fetch. */
export const localModelFiles = (entry: LocalModelEntry): LocalModelFile[] =>
  entry.projector === undefined ? [entry.weights] : [entry.weights, entry.projector]

/**
 * The URL an executor asks for. Built from the entry's own key and the host
 * the executor was configured with — never from anything the server sent.
 */
export const localModelFileUrl = (file: LocalModelFile, baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/${file.key}`
