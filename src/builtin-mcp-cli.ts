import { isAbsolute } from 'node:path'

import { AGENT_GUARD_COMMAND, AGENT_GUARD_USAGE, runCodingAgentGuard } from './coding-session/agent-guard.js'

/**
 * The MCP servers this executor ships itself, the coding-session host the
 * coding bridge detaches, and the guard a host starts its agent through. Each
 * is started by the daemon (or by the bridge, or the host) with an exact
 * argv, so anything else on the command line is refused rather than guessed
 * at. Each loads only its own modules, when it is the one asked for: a host
 * and its guard start for every session and agent, and none of them loads the
 * daemon's commands (`cli.ts`).
 */
const CODING_SESSION_MCP_USAGE = 'Usage: nessie-executor serve-coding-session-mcp --config <absolute-owner-only-file>'
const CODING_SESSION_HOST_USAGE = 'Usage: nessie-executor coding-session-host --config <absolute-owner-only-file> --session <uuid>'

const configPath = (args: readonly string[], usage: string): string => {
  const value = args[args.indexOf('--config') + 1]
  if (!args.includes('--config') || !value || !isAbsolute(value)) throw new Error(usage)
  return value
}

export const runBuiltinMcpCli = async (args: string[]): Promise<boolean> => {
  if (args[0] === 'serve-existing-claude-channel') {
    if (args.length !== 3 || args[1] !== '--state-dir' || !args[2] || !isAbsolute(args[2])) {
      throw new Error('Usage: nessie-executor serve-existing-claude-channel --state-dir <absolute-pairing-directory>')
    }
    const { serveExistingClaudeChannel } = await import('./existing-session/claude-channel.js')
    await serveExistingClaudeChannel(args[2])
    return true
  }
  if (args[0] === 'terminal-session-process') {
    if (args.length !== 1) throw new Error('Usage: nessie-executor terminal-session-process')
    await (await import('./coding-session/terminal-process.js')).runTerminalProcess()
    return true
  }
  if (args[0] === 'serve-ollama-search-mcp') {
    if (args.length !== 1) throw new Error('Usage: nessie-executor serve-ollama-search-mcp')
    await (await import('./ollama-search-mcp.js')).serveOllamaSearchMcp()
    return true
  }
  if (args[0] === 'serve-coding-session-mcp') {
    if (args.length !== 3) throw new Error(CODING_SESSION_MCP_USAGE)
    const { serveCodingSessionMcp } = await import('./coding-session/bridge-server.js')
    await serveCodingSessionMcp(configPath(args, CODING_SESSION_MCP_USAGE))
    return true
  }
  if (args[0] === 'serve-session-secrets') {
    if (args.length !== 3 || args[1] !== '--session-dir' || !args[2] || !isAbsolute(args[2])) {
      throw new Error('Usage: nessie-executor serve-session-secrets --session-dir <absolute-session-directory>')
    }
    await (await import('./coding-session/session-secret-mcp.js')).serveSessionSecrets(args[2])
    return true
  }
  if (args[0] === 'coding-session-host') {
    const session = args[args.indexOf('--session') + 1]
    if (args.length !== 5 || !args.includes('--session') || !session) throw new Error(CODING_SESSION_HOST_USAGE)
    const { runCodingSessionHost } = await import('./coding-session/host.js')
    await runCodingSessionHost({ configPath: configPath(args, CODING_SESSION_HOST_USAGE), sessionId: session })
    // A detached host has no parent waiting on it; leave as soon as the session is served.
    process.exit(0)
  }
  if (args[0] === AGENT_GUARD_COMMAND) {
    if (args.length !== 1) throw new Error(AGENT_GUARD_USAGE)
    // It exits with its agent, or once it has stopped the agent of a host that died.
    await runCodingAgentGuard()
    return true
  }
  return false
}
