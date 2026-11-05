import type { ExecutorLocalMcpServer } from './mcp-servers.js'

/**
 * How a caller names the local MCP servers an executor fronts, kept in one
 * place because `configure` and the `--configuration-input-stdin` form have to
 * agree about them.
 *
 *   --mcp-server 'kelpie=kelpie mcp'
 *   --mcp-server 'kelpie=/opt/homebrew/bin/kelpie mcp' --mcp-server 'other=…'
 *   --clear-mcp-servers
 *
 * The value is `<name>=<argv>`, and the argv is split on spaces. That is
 * deliberately a simple grammar rather than a shell one: these servers are
 * started with `spawn`, never through a shell, so a spelling that implied
 * quoting or globbing would promise something the daemon does not do.
 *
 * Nothing here decides whether a server is acceptable. The name grammar, the
 * argv bounds and the duplicate rule live in `assertExecutorLocalMcpServers`,
 * so a policy proposed over stdin cannot reach a weaker set of rules than one
 * typed on a terminal.
 */
export const parseExecutorMcpServerArguments = (
  args: readonly string[],
): ExecutorLocalMcpServer[] | undefined => {
  if (args.includes('--clear-mcp-servers')) {
    if (args.includes('--mcp-server')) {
      throw new Error('Name MCP servers with --mcp-server, or remove them all with --clear-mcp-servers.')
    }
    return []
  }
  if (!args.includes('--mcp-server')) return undefined
  const servers: ExecutorLocalMcpServer[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--mcp-server') continue
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error('--mcp-server needs <name>=<command and arguments>.')
    }
    const separator = value.indexOf('=')
    if (separator < 1) {
      throw new Error(`--mcp-server needs <name>=<command and arguments>, not "${value.slice(0, 80)}".`)
    }
    const command = value
      .slice(separator + 1)
      .split(' ')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    if (command.length === 0) {
      throw new Error(`The MCP server "${value.slice(0, separator)}" needs a command to start.`)
    }
    servers.push({ command, name: value.slice(0, separator) })
  }
  return servers
}
