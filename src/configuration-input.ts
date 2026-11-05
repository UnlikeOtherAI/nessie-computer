import type { Readable } from 'node:stream'
import { parseLocalCommandPolicy, type LocalCommandPolicy } from './command-policy.js'

import type { ExecutorLocalMcpServer } from './mcp-servers.js'
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
 */
export type ExecutorConfigurationInput = {
  existingCodingSessionsEnabled?: boolean
  commandPolicy?: LocalCommandPolicy
  codingSessions?: unknown
  commandAllowlist?: string[]
  mcpServers?: ExecutorLocalMcpServer[]
  operationKeys: string[]
  workspaceFolders: ExecutorWorkspaceFolder[]
}

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
