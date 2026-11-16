import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { createCodingBridge, type CodingBridgeCallMeta, type CodingBridge } from './bridge.js'
import { codingBridgeTools, CodingBridgeError } from './bridge-tools.js'
import { loadCodingSessionsConfig } from './config.js'
import { debugFailure, executorDebugChild } from '../debug-mode.js'
import { parseLocalCommandPolicy, type LocalCommandPolicy } from '../command-policy.js'
import {
  CODING_SESSION_COMMAND_META,
  CODING_SESSION_COMMAND_RULES_META,
  CODING_SESSION_DAEMON_CONTROL_META,
  CODING_SESSION_OWNER_META,
  CODING_SESSION_AUTHORITY_META, CODING_SESSION_PAIRING_SOURCE_META, CODING_SESSION_REFERENCE_META,
  CODING_SESSION_CONNECTION_META,
} from './meta-keys.js'
import type { PathRewriter } from './path-rewrite.js'
import { PersonalInferenceAuthoritySchema, ExecutorCodingSessionAuthoritySchema,
  ExecutorSessionPairingSourceSchema } from '@nessie/executor-protocol'
import { preparedManagedSessionResultScope } from './session-authority.js'

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
  const sessionReference = ExecutorCodingSessionAuthoritySchema.safeParse(fields[CODING_SESSION_REFERENCE_META])
  const source = ExecutorSessionPairingSourceSchema.safeParse(fields[CODING_SESSION_PAIRING_SOURCE_META])
  const connection = fields[CODING_SESSION_CONNECTION_META]
  return {
    ...(typeof owner === 'string' ? { ownerKey: owner } : {}),
    ...(typeof command === 'string' ? { commandId: command } : {}),
    daemonControl: fields[CODING_SESSION_DAEMON_CONTROL_META] === true,
    ...(commandRules ? { commandRules } : {}),
    ...(personalAuthority.success ? { personalAuthority: personalAuthority.data } : {}),
    ...(sessionAuthority.success ? { codingSessionAuthority: sessionAuthority.data } : {}),
    ...(sessionReference.success ? { codingSessionReference: sessionReference.data } : {}),
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
  if (key === 'resultScope' || key === 'startEvidence') return value
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

/** The same result boundary is used by the stdio transport; execution and publication have separate leases. */
export const callCodingBridgeTool = async (
  bridge: CodingBridge, request: { name: string; arguments?: unknown; _meta?: unknown },
) => {
  const meta = codingBridgeCallMeta(request._meta)
  try {
    const result = await bridge.call(request.name, request.arguments, meta)
    const scope = preparedManagedSessionResultScope(meta)
    return { content: [{ type: 'text' as const, text: JSON.stringify(rewriteCodingAnswer({ ...result,
      ...(scope ? { resultScope: scope } : {}) }, bridge.rewriter)) }] }
  } catch (error) {
    const known = error instanceof CodingBridgeError
    // No raw failure detail enters the daemon log or its result journal. Debug
    // mode is the owner's own terminal, where the detail is the point.
    if (!known) process.stderr.write('[coding-sessions] unexpected bridge failure\n')
    if (executorDebugChild()) {
      process.stderr.write(`[coding-sessions] debug: ${request.name} failed: ${debugFailure(error)}\n`)
    }
    const scope = preparedManagedSessionResultScope(meta)
    const answer = {
      code: known ? error.code : 'coding_session_unavailable',
      message: known ? error.message : 'The coding-sessions bridge could not complete that call.',
      ...(scope ? { resultScope: scope } : {}),
    }
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(rewriteCodingAnswer(answer, bridge.rewriter)) }] }
  }
}

export const serveCodingSessionMcp = async (configPath: string): Promise<void> => {
  const loaded = await loadCodingSessionsConfig(configPath)
  const bridge = await createCodingBridge(loaded)
  const tools = codingBridgeTools(loaded)
  const server = new Server({ name: 'nessie-coding-sessions', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return callCodingBridgeTool(bridge, request.params)
  })
  await server.connect(new StdioServerTransport())
}
