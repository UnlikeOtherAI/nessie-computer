import { createHash } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { loadCodingSessionsConfig } from './coding-session/config.js'
import { codingSessionsConfigPath } from './coding-sessions-policy.js'
import { readLocalOpenAiConfig } from './openai-local-config.js'
import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { assertOwnerOnlyStatePath } from './state-security.js'
import { loadExecutorState, withStateMutationLock } from './state-store.js'

export const DEEPTEST_INFERENCE_GRANT_FILE = 'deeptest-inference-grant.json'
export const DEEPTEST_INFERENCE_ENGINES = ['ollama', 'openai', 'codex', 'claude'] as const
export type DeepTestInferenceEngine = typeof DEEPTEST_INFERENCE_ENGINES[number]
export type DeepTestInferenceGrant = {
  executorId: string
  engines: DeepTestInferenceEngine[]
  ollamaContextLength?: number
  openaiConfigDigest?: string
  codingConfigDigest?: string
}

export const inferenceConfigDigest = (value: unknown): string =>
  createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')

const invalid = (): never => { throw new Error('The DeepTest inference grant is unavailable or malformed.') }

export const parseDeepTestInferenceGrant = (input: unknown): DeepTestInferenceGrant => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const value = input as Record<string, unknown>
  const keys = ['executorId', 'engines', 'ollamaContextLength', 'openaiConfigDigest', 'codingConfigDigest']
  if (Object.keys(value).some((key) => !keys.includes(key))
    || typeof value.executorId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.executorId)
    || !Array.isArray(value.engines) || value.engines.length < 1 || value.engines.length > 4
    || new Set(value.engines).size !== value.engines.length
    || !value.engines.every((engine) =>
      DEEPTEST_INFERENCE_ENGINES.includes(engine as DeepTestInferenceEngine))) {
    return invalid()
  }
  if (value.ollamaContextLength !== undefined
    && (!value.engines.includes('ollama') || !Number.isSafeInteger(value.ollamaContextLength)
      || (value.ollamaContextLength as number) <= 0
      || (value.ollamaContextLength as number) > 1_000_000)) return invalid()
  for (const key of ['openaiConfigDigest', 'codingConfigDigest']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(value[key]))) return invalid()
  }
  if (value.engines.includes('openai') !== (value.openaiConfigDigest !== undefined)
    || (value.engines.includes('codex') || value.engines.includes('claude')) !== (value.codingConfigDigest !== undefined)) return invalid()
  return value as DeepTestInferenceGrant
}

/** The credential-free grant never contains endpoints, native argv, roots, or authentication. */
export const loadDeepTestInferenceGrant = async (path: string): Promise<DeepTestInferenceGrant> => {
  if (!isAbsolute(path) || path.includes('\0') || basename(path) !== DEEPTEST_INFERENCE_GRANT_FILE) return invalid()
  await assertOwnerOnlyStatePath(dirname(path), 'directory')
  await assertOwnerOnlyStatePath(path, 'file')
  const bytes = await readFile(path)
  if (bytes.byteLength > 4096) return invalid()
  try { return parseDeepTestInferenceGrant(JSON.parse(bytes.toString('utf8')) as unknown) }
  catch { return invalid() }
}

export const currentInferenceConfig = async (stateDir: string, grant: DeepTestInferenceGrant): Promise<void> => {
  // Native Desktop can forget a pairing independently of the Node grant publisher.
  // Inspect only the authority file's existence/privacy, never its credential-bearing contents.
  await assertOwnerOnlyStatePath(join(stateDir, 'executor-state.json'), 'file')
  if (grant.engines.includes('openai')) {
    const config = await readLocalOpenAiConfig(stateDir)
    if (!config || inferenceConfigDigest(config) !== grant.openaiConfigDigest) return invalid()
  }
  if (grant.engines.includes('codex') || grant.engines.includes('claude')) {
    await assertOwnerOnlyStatePath(codingSessionsConfigPath(stateDir), 'file')
    const loaded = await loadCodingSessionsConfig(codingSessionsConfigPath(stateDir))
    if (inferenceConfigDigest(loaded.config) !== grant.codingConfigDigest) return invalid()
    for (const name of ['codex', 'claude'] as const) {
      if (grant.engines.includes(name) && !loaded.config.agents[name]) return invalid()
    }
  }
}

export const publishDeepTestInferenceGrant = async (
  stateDir: string, engines: DeepTestInferenceEngine[], confirmed: boolean,
  options: { ollamaContextLength?: number } = {},
): Promise<string> => {
  if (confirmed !== true || !isAbsolute(stateDir)) return invalid()
  await assertOwnerOnlyStatePath(stateDir, 'directory')
  return withStateMutationLock(stateDir, async () => {
    const state = await loadExecutorState(stateDir)
    const openai = engines.includes('openai') ? await readLocalOpenAiConfig(stateDir) : null
    if (engines.includes('openai') && !openai) return invalid()
    const coding = engines.includes('codex') || engines.includes('claude')
      ? await loadCodingSessionsConfig(codingSessionsConfigPath(stateDir)) : null
    const grant = parseDeepTestInferenceGrant({ executorId: state.executorId, engines,
      ...(options.ollamaContextLength === undefined ? {} : { ollamaContextLength: options.ollamaContextLength }),
      ...(openai ? { openaiConfigDigest: inferenceConfigDigest(openai) } : {}),
      ...(coding ? { codingConfigDigest: inferenceConfigDigest(coding.config) } : {}),
    })
    await currentInferenceConfig(stateDir, grant)
    const path = join(stateDir, DEEPTEST_INFERENCE_GRANT_FILE)
    await replaceOwnerOnlyJson(path, grant)
    return path
  })
}

export const revokeDeepTestInferenceGrant = async (stateDir: string): Promise<void> => {
  if (!isAbsolute(stateDir)) return invalid()
  await assertOwnerOnlyStatePath(stateDir, 'directory')
  await withStateMutationLock(stateDir, async () => {
    const path = join(stateDir, DEEPTEST_INFERENCE_GRANT_FILE)
    try { await assertOwnerOnlyStatePath(path, 'file'); await unlink(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  })
}
