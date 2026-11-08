import type { Readable } from 'node:stream'
import { parseLocalCommandPolicy, type LocalCommandPolicy } from './command-policy.js'

import { compileExecutorEgressPolicy } from './egress-policy.js'
import type { DiscoveredLocalApp } from './local-app-discovery.js'
import { parseLocalMcpPolicy, type LocalMcpPolicy } from './mcp-policy.js'
import type { ExecutorLocalMcpServer } from './mcp-servers.js'
import type { ExecutorLocalState } from './state-store.js'
import { workspaceFoldersFromInput, type ExecutorWorkspaceFolder } from './workspace-folder-arguments.js'

/**
 * `configure --configuration-input-stdin`: the whole local policy proposal as
 * one JSON document, which is how the desktop companion, the menu bar app and
 * the tray propose one without putting paths or programs on a command line.
 *
 * The shape is checked only as far as handing each part to the function that
 * owns its rules: `configureExecutorLocalPolicy` for the operations, the
 * allowlist and the named servers, `normalizeCodingSessionsConfig` for the
 * coding-sessions bridge. A key that is absent keeps what the policy already
 * says; `[]` (or `null` for `codingSessions`) removes it.
 *
 * `mcpPolicy` (local apps) and `allowedOrigins` (websites) are the
 * {@link ExecutorConfigurationSettings} the same writer takes as its last
 * argument.
 */
export type ExecutorConfigurationInput = ExecutorConfigurationSettings & {
  existingCodingSessionsEnabled?: boolean
  commandPolicy?: LocalCommandPolicy
  codingSessions?: unknown
  commandAllowlist?: string[]
  mcpServers?: ExecutorLocalMcpServer[]
  operationKeys: string[]
  workspaceFolders: ExecutorWorkspaceFolder[]
}

/**
 * What `configureExecutorLocalPolicy` takes beside the policy proper. Absent
 * keeps what the state says. `discover` is how the `installed` local-apps
 * policy finds this computer's servers; the real discovery when omitted.
 */
export type ExecutorConfigurationSettings = {
  mcpPolicy?: LocalMcpPolicy
  /** HTTPS origins the guest browser may open; `[]` is no websites. */
  allowedOrigins?: string[]
  discover?: () => Promise<DiscoveredLocalApp[]>
}

/** Each origin as the browser gateway reads it, once, in one order. */
export const configuredAllowedOrigins = (origins: readonly string[]): string[] => (
  origins.length === 0 ? [] : [...compileExecutorEgressPolicy({ allowedOrigins: [...origins] }).allowedOrigins].sort()
)

/**
 * Where the websites live (contract §4.6): in the guest browser's own
 * configuration once it is set up — exactly where `configure-browser` stores
 * them — and until then on the state itself, so choosing websites never
 * waits for the browser.
 */
export const websitesFor = (
  state: ExecutorLocalState, origins: readonly string[],
): Pick<ExecutorLocalState, 'allowedOrigins' | 'browserSandbox'> => {
  const allowedOrigins = configuredAllowedOrigins(origins)
  return state.browserSandbox
    ? { browserSandbox: { ...state.browserSandbox, allowedOrigins } }
    : { allowedOrigins }
}

/** The effective websites, wherever they are stored. */
export const allowedOriginsOf = (state: Pick<ExecutorLocalState, 'allowedOrigins' | 'browserSandbox'>): string[] => (
  [...(state.browserSandbox?.allowedOrigins ?? state.allowedOrigins ?? [])]
)

// A coding-sessions configuration may itself be up to 64 KiB, and it rides in
// the same document as everything else the policy names.
const MAX_CONFIGURATION_INPUT_BYTES = 96 * 1024

const malformed = (): never => {
  throw new Error('Local policy input on standard input is malformed.')
}

export const parseConfigurationInput = (text: string): ExecutorConfigurationInput => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return malformed()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return malformed()
  const input = parsed as Record<string, unknown>
  const allowlist = input.commandAllowlist
  const servers = input.mcpServers
  const codingSessions = input.codingSessions
  const origins = input.allowedOrigins
  if (
    (input.existingCodingSessionsEnabled !== undefined && typeof input.existingCodingSessionsEnabled !== 'boolean')
    || !Array.isArray(input.operationKeys)
    || !input.operationKeys.every((key) => typeof key === 'string')
    // Absent keeps the permitted programs the policy already names; present it
    // must be a list of names, and `[]` is the instruction to clear them.
    || (allowlist !== undefined && (
      !Array.isArray(allowlist) || !allowlist.every((program) => typeof program === 'string')
    ))
    // Same reading as the allowlist: absent keeps the named servers, `[]`
    // removes them all. The shape is checked only far enough to hand it to
    // `assertExecutorLocalMcpServers`, which owns every real rule.
    || (servers !== undefined && (
      !Array.isArray(servers) || !servers.every((server) => (
        Boolean(server)
        && typeof server === 'object'
        && !Array.isArray(server)
        && typeof (server as { name?: unknown }).name === 'string'
        && Array.isArray((server as { command?: unknown }).command)
      ))
    ))
    // An object configures the bridge and `null` withdraws it; the object's
    // own grammar is the coding-sessions configuration's.
    || (codingSessions !== undefined && codingSessions !== null && (
      typeof codingSessions !== 'object' || Array.isArray(codingSessions)
    ))
    || (origins !== undefined && (!Array.isArray(origins) || !origins.every((origin) => typeof origin === 'string')))
  ) {
    return malformed()
  }
  return {
    ...(input.commandPolicy === undefined ? {} : { commandPolicy: parseLocalCommandPolicy(input.commandPolicy) }),
    ...(input.existingCodingSessionsEnabled === undefined ? {}
      : { existingCodingSessionsEnabled: input.existingCodingSessionsEnabled as boolean }),
    ...(codingSessions === undefined ? {} : { codingSessions }),
    ...(allowlist === undefined ? {} : { commandAllowlist: allowlist as string[] }),
    ...(servers === undefined ? {} : { mcpServers: servers as ExecutorLocalMcpServer[] }),
    ...(input.mcpPolicy === undefined ? {} : { mcpPolicy: parseLocalMcpPolicy(input.mcpPolicy) }),
    ...(origins === undefined ? {} : { allowedOrigins: configuredAllowedOrigins(origins as string[]) }),
    operationKeys: input.operationKeys as string[],
    workspaceFolders: workspaceFoldersFromInput(parsed, 'Local policy input on standard input'),
  }
}

export const readConfigurationInput = async (
  stream: Readable = process.stdin,
): Promise<ExecutorConfigurationInput> => {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    byteLength += bytes.byteLength
    if (byteLength > MAX_CONFIGURATION_INPUT_BYTES) throw new Error('Local policy input is too large.')
    chunks.push(bytes)
  }
  return parseConfigurationInput(Buffer.concat(chunks).toString('utf8'))
}
