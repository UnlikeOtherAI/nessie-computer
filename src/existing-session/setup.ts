import { isBuiltinCodingSessionsServer, withBridgeOnRuntime } from '../coding-sessions-policy.js'
import type { ExecutorLocalState } from '../state-store.js'

/** Local-only setup for Claude's native channel requirement, using the installed executor's launch vector. */
export const existingClaudeChannelConfiguration = (state: ExecutorLocalState, stateDir: string) => {
  const bridge = withBridgeOnRuntime(state.mcpServers ?? []).find(isBuiltinCodingSessionsServer)
  if (!bridge) return undefined
  const prefix = bridge.command.slice(0, bridge.command.indexOf('serve-coding-session-mcp'))
  return { mcpServers: { nessie: {
    command: prefix[0], args: [...prefix.slice(1), 'serve-existing-claude-channel', '--state-dir', stateDir],
    ...(bridge.env?.NESSIE_EXECUTOR_PACKAGED_CLI === '1' ? { env: { NESSIE_EXECUTOR_PACKAGED_CLI: '1' } } : {}),
  } } }
}
