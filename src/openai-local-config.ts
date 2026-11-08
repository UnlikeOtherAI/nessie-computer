import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { assertOwnerOnlyStatePath } from './state-security.js'
import { inferenceEndpointUrl } from './inference-endpoint-network.js'

export const OPENAI_ENDPOINT_FILE = 'local-openai-endpoint.json'

/**
 * Where the owner's model server listens. The server describes its own models;
 * the owner names only the address and confirms it is served on this computer.
 */
export type LocalOpenAiConfig = {
  baseUrl: string
  apiKey?: string
} & ({ localServiceConfirmed: true; networkServiceConfirmed?: never }
  | { networkServiceConfirmed: true; localServiceConfirmed?: never })

/**
 * Earlier releases asked the owner to describe each model by hand. The server's
 * own report replaced that list, so a saved one is read past rather than refused:
 * an update must not take a working endpoint offline.
 */
const SUPERSEDED_KEYS = ['models']

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

/** The OpenAI API root: the owner's path, or `/v1` when they named only the server's port. */
export const localOpenAiApiBase = (config: LocalOpenAiConfig): string =>
  new URL(config.baseUrl).pathname === '/' ? `${config.baseUrl}/v1` : config.baseUrl

/** The server itself, where llama.cpp-family servers describe the loaded model and Ollama its version. */
export const localModelServerOrigin = (config: LocalOpenAiConfig): string => new URL(config.baseUrl).origin

export const parseLocalOpenAiConfig = (input: unknown): LocalOpenAiConfig => {
  if (!record(input) || Object.keys(input).some((key) =>
    !['baseUrl', 'apiKey', 'localServiceConfirmed', 'networkServiceConfirmed', ...SUPERSEDED_KEYS].includes(key))
    || typeof input.baseUrl !== 'string' || input.baseUrl.length > 512
    || !((input.localServiceConfirmed === true && input.networkServiceConfirmed === undefined)
      || (input.networkServiceConfirmed === true && input.localServiceConfirmed === undefined))
    || input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096
      || /[\r\n]/.test(input.apiKey))) return invalid()
  return { ...(input.networkServiceConfirmed === true
    ? { baseUrl: inferenceEndpointUrl(input.baseUrl as string), networkServiceConfirmed: true as const }
    : { baseUrl: localOpenAiBaseUrl(input.baseUrl as string), localServiceConfirmed: true as const }),
    ...(typeof input.apiKey === 'string' && input.apiKey ? { apiKey: input.apiKey } : {}) }
}

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
