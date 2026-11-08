import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { createCodingBridge, type CodingBridgeCallMeta } from './bridge.js'
import { codingBridgeTools, CodingBridgeError } from './bridge-tools.js'
import { loadCodingSessionsConfig } from './config.js'
import { parseLocalCommandPolicy, type LocalCommandPolicy } from '../command-policy.js'
import {
  CODING_SESSION_COMMAND_META,
  CODING_SESSION_COMMAND_RULES_META,
  CODING_SESSION_DAEMON_CONTROL_META,
  CODING_SESSION_OWNER_META,
  CODING_SESSION_AUTHORITY_META, CODING_SESSION_PAIRING_SOURCE_META,
  CODING_SESSION_CONNECTION_META,
} from './meta-keys.js'
import type { PathRewriter } from './path-rewrite.js'
import { PersonalInferenceAuthoritySchema, ExecutorCodingSessionAuthoritySchema,
  ExecutorSessionPairingSourceSchema } from '@nessie/executor-protocol'

/**
 * `nessie-executor serve-coding-session-mcp --config <abs path>`: the
 * coding-sessions bridge as an MCP stdio server, on the official SDK like
 * `serve-ollama-search-mcp`.
 *
 * The daemon passes the model's `arguments` untouched and sets reserved
 * `_meta` keys the model cannot reach, on calls to this built-in bridge only:
 * the owner key, the executor command id (which makes a replayed call a no-op),
 * the daemon-control marker that only the daemon's own teardown calls carry,
 * and this computer's command rules, which decide what a terminal may start.
 * Every answer is rewritten once more on its way out, string by string, so no
 * host path survives even in text the bridge itself composed.
 */
export { CODING_SESSION_COMMAND_META, CODING_SESSION_DAEMON_CONTROL_META, CODING_SESSION_OWNER_META }

/** Rules that do not parse are no rules, and a terminal start without rules is refused. */
const commandRulesOf = (value: unknown): LocalCommandPolicy | undefined => {
  try { return value === undefined ? undefined : parseLocalCommandPolicy(value) } catch { return undefined }
}

export const codingBridgeCallMeta = (meta: unknown): CodingBridgeCallMeta => {
  const fields = meta && typeof meta === 'object' ? meta as Record<string, unknown> : {}
  const owner = fields[CODING_SESSION_OWNER_META]
  const command = fields[CODING_SESSION_COMMAND_META]
  const commandRules = commandRulesOf(fields[CODING_SESSION_COMMAND_RULES_META])
  const personalAuthority = PersonalInferenceAuthoritySchema.safeParse(fields['nessie/personal-authority'])
  const sessionAuthority = ExecutorCodingSessionAuthoritySchema.safeParse(fields[CODING_SESSION_AUTHORITY_META])
  const source = ExecutorSessionPairingSourceSchema.safeParse(fields[CODING_SESSION_PAIRING_SOURCE_META])
  const connection = fields[CODING_SESSION_CONNECTION_META]
  return {
    ...(typeof owner === 'string' ? { ownerKey: owner } : {}),
    ...(typeof command === 'string' ? { commandId: command } : {}),
    daemonControl: fields[CODING_SESSION_DAEMON_CONTROL_META] === true,
    ...(commandRules ? { commandRules } : {}),
    ...(personalAuthority.success ? { personalAuthority: personalAuthority.data } : {}),
    ...(sessionAuthority.success ? { codingSessionAuthority: sessionAuthority.data } : {}),
    ...(source.success ? { sessionPairingSource: source.data } : {}),
    ...(typeof connection === 'string' ? { connectionEpoch: connection } : {}),
  }
}

/**
 * Fields whose values are identifiers or fixed values that other code parses,
 * never prose: the daemon's report drops a session whose `agent`, `root` or
 * `reason` no longer matches its schema, and a model that reads `root: '<user>'`
 * cannot start a session there. They get the path rules only, as does a pull
 * request's `url`, whose owner is a repository's, not this machine's.
 */
const FIXED_VALUE_KEYS = new Set([
  'sessionId', 'ownerKey', 'agent', 'agents', 'status', 'reason', 'root', 'rootName', 'name', 'path', 'createdAt', 'updatedAt',
  'lastTurnEndedAt', 'at',
  'origin', 'provider', 'nativeId', 'providerMessageId', 'nativeQueueId', 'nextCursorProvider',
  'baseCommit', 'code', 'nextCursor', 'kind', 'subtype', 'state', 'mergeable', 'url', 'unavailable', 'incomplete',
])

/** The last pass over an answer: every string value, keyed as above. */
export const rewriteCodingAnswer = (value: unknown, rewriter: PathRewriter, key?: string): unknown => {
  if (typeof value === 'string') {
    return key !== undefined && FIXED_VALUE_KEYS.has(key) ? rewriter.rewritePaths(value) : rewriter.rewrite(value)
  }
  if (Array.isArray(value)) return value.map((entry) => rewriteCodingAnswer(entry, rewriter, key))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [
      name, rewriteCodingAnswer(entry, rewriter, name),
    ]))
  }
  return value
}

export const serveCodingSessionMcp = async (configPath: string): Promise<void> => {
  const loaded = await loadCodingSessionsConfig(configPath)
  const bridge = await createCodingBridge(loaded)
  const tools = codingBridgeTools(loaded)
  const server = new Server({ name: 'nessie-coding-sessions', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const meta = codingBridgeCallMeta(request.params._meta)
    try {
      const result = await bridge.call(request.params.name, request.params.arguments, meta)
      return { content: [{ type: 'text', text: JSON.stringify(rewriteCodingAnswer(result, bridge.rewriter)) }] }
    } catch (error) {
      const known = error instanceof CodingBridgeError
      // The full error stays in the daemon's local log; only a code and fixed text travel.
      if (!known) process.stderr.write(`[coding-sessions] ${error instanceof Error ? error.message : String(error)}\n`)
      const answer = {
        code: known ? error.code : 'coding_session_unavailable',
        message: known ? error.message : 'The coding-sessions bridge could not complete that call.',
      }
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(rewriteCodingAnswer(answer, bridge.rewriter)) }] }
    }
  })
  await server.connect(new StdioServerTransport())
}
