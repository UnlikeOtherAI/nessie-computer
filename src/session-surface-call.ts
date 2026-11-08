import type { ExecutorCodingSessionAuthority, ExecutorSessionPairingSource } from '@nessie/executor-protocol'
import type { ExecutorMcpSessionManager } from './mcp-session-manager.js'
import { validateScopedCodingResult } from './coding-session/session-result-authority.js'
import { CODING_SESSION_AUTHORITY_META, CODING_SESSION_COMMAND_META, CODING_SESSION_CONNECTION_META,
  CODING_SESSION_DAEMON_CONTROL_META, CODING_SESSION_OWNER_META,
  CODING_SESSION_PAIRING_SOURCE_META } from './coding-session/meta-keys.js'

/** Viewer and action results pass the same pre-sidecar publication boundary as ordinary commands. */
export const callSessionSurface = async (input: {
  sessions: ExecutorMcpSessionManager; server: string; tool: 'session_conversation' | 'session_user_action'
  arguments: Record<string, unknown>; ownerKey: string; commandId: string
  authority?: ExecutorCodingSessionAuthority
  source: () => ExecutorSessionPairingSource | undefined; epoch: () => string | undefined
  validate?: (scope: ExecutorCodingSessionAuthority, phase: 'execute' | 'publish') => Promise<ExecutorCodingSessionAuthority>
}) => {
  let scope = input.authority
  const bound = input.source()?.kind !== 'unbound_local'
  if (bound && (!scope || !input.validate || scope.commandId !== input.commandId || scope.ownerKey !== input.ownerKey
    || scope.operation !== (input.tool === 'session_conversation' ? 'session_view' : 'session_user_action')
    || scope.admissions[0]?.sessionId !== input.arguments.sessionId)) throw new Error('Original session authority unavailable')
  const meta = () => ({ [CODING_SESSION_DAEMON_CONTROL_META]: true,
    [CODING_SESSION_COMMAND_META]: input.commandId, [CODING_SESSION_OWNER_META]: input.ownerKey,
    [CODING_SESSION_PAIRING_SOURCE_META]: input.source(), [CODING_SESSION_CONNECTION_META]: input.epoch(),
    ...(scope ? { [CODING_SESSION_AUTHORITY_META]: scope } : {}) })
  return input.sessions.callTool(input.server, input.tool, input.arguments, meta(), undefined, undefined, bound ? {
    prepareMeta: async () => { scope = await input.validate!(scope!, 'execute'); return meta() },
    validateResult: async result => {
      scope = await input.validate!(scope!, 'publish')
      return validateScopedCodingResult(result, scope)
    },
  } : undefined)
}
