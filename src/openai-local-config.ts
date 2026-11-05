import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { canonicalExecutorJson } from '@nessie/executor-protocol'

import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { assertOwnerOnlyStatePath } from './state-security.js'

export const OPENAI_ENDPOINT_FILE = 'local-openai-endpoint.json'
export type LocalOpenAiConfig = {
  baseUrl: string
  apiKey?: string
  localServiceConfirmed: true
  models: Array<{
    id: string
    revision: string
    contextLength: number
    maxOutputTokens: number
    tools: boolean
    thinking: boolean
    vision?: boolean
  }>
}

export class LocalOpenAiError extends Error {
  override readonly name = 'LocalOpenAiError'
  constructor(readonly code: string) { super(code) }
}

const invalid = (): never => { throw new LocalOpenAiError('endpoint_configuration_invalid') }
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** localhost is canonicalized without DNS; all other names and non-loopback IPs fail closed. */
export const localOpenAiBaseUrl = (input: string): string => {
  let url: URL
  try { url = new URL(input) } catch { return invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return invalid()
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') return invalid()
  if (!/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(url.pathname)) return invalid()
  return url.toString().replace(/\/$/, '')
}

export const parseLocalOpenAiConfig = (input: unknown): LocalOpenAiConfig => {
  if (!record(input) || Object.keys(input).some((key) =>
    !['baseUrl', 'apiKey', 'localServiceConfirmed', 'models'].includes(key))
    || typeof input.baseUrl !== 'string' || input.baseUrl.length > 512 || input.localServiceConfirmed !== true
    || input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096
      || /[\r\n]/.test(input.apiKey))
    || !Array.isArray(input.models) || input.models.length < 1 || input.models.length > 100) return invalid()
  const models = input.models.map((model: unknown) => {
    if (!record(model) || Object.keys(model).some((key) =>
      !['id', 'revision', 'contextLength', 'maxOutputTokens', 'tools', 'thinking', 'vision'].includes(key))
      || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 200
      || typeof model.revision !== 'string' || !model.revision.trim() || model.revision.length > 256
      || !Number.isInteger(model.contextLength) || Number(model.contextLength) < 1
      || Number(model.contextLength) > 1_000_000 || !Number.isInteger(model.maxOutputTokens)
      || Number(model.maxOutputTokens) < 1 || Number(model.maxOutputTokens) >= Number(model.contextLength)
      || Number(model.maxOutputTokens) > 100_000 || typeof model.tools !== 'boolean'
      || typeof model.thinking !== 'boolean'
      || model.vision !== undefined && typeof model.vision !== 'boolean') return invalid()
    return { id: model.id, revision: model.revision, contextLength: Number(model.contextLength),
      maxOutputTokens: Number(model.maxOutputTokens),
      tools: model.tools, thinking: model.thinking,
      ...(model.vision === undefined ? {} : { vision: model.vision }) }
  })
  if (new Set(models.map((model) => model.id)).size !== models.length) return invalid()
  return { baseUrl: localOpenAiBaseUrl(input.baseUrl), localServiceConfirmed: true, models,
    ...(typeof input.apiKey === 'string' && input.apiKey ? { apiKey: input.apiKey } : {}) }
}

/** An owner-authored endpoint/model manifest pin, explicitly not a verified weights digest. */
export const localOpenAiManifestDigest = (
  config: LocalOpenAiConfig, model: LocalOpenAiConfig['models'][number],
): string => createHash('sha256').update(canonicalExecutorJson({
  protocol: 'openai-chat-completions-v1', baseUrl: config.baseUrl, model,
  localServiceConfirmed: config.localServiceConfirmed,
})).digest('hex')

export const readLocalOpenAiConfig = async (stateDir: string): Promise<LocalOpenAiConfig | null> => {
  if (!isAbsolute(stateDir)) return invalid()
  await assertOwnerOnlyStatePath(stateDir, 'directory')
  const path = join(stateDir, OPENAI_ENDPOINT_FILE)
  try { await lstat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  await assertOwnerOnlyStatePath(path, 'file')
  const bytes = await readFile(path)
  if (bytes.length > 64 * 1024) return invalid()
  try { return parseLocalOpenAiConfig(JSON.parse(bytes.toString('utf8')) as unknown) }
  catch { return invalid() }
}

export const saveLocalOpenAiConfig = async (stateDir: string, config: LocalOpenAiConfig): Promise<void> => {
  if (!isAbsolute(stateDir)) return invalid()
  await assertOwnerOnlyStatePath(stateDir, 'directory')
  await replaceOwnerOnlyJson(join(stateDir, OPENAI_ENDPOINT_FILE), parseLocalOpenAiConfig(config))
}
