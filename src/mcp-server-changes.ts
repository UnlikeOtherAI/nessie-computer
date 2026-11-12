import { EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME, ExecutorMcpServerNameSchema } from '@nessie/executor-protocol'

import type { ExecutorLocalMcpServer } from './mcp-servers.js'

/**
 * Which local MCP servers a configuration input asks `configure` to keep.
 *
 * `describe` never shows a server's `env` (it can hold secrets), so a client
 * that edits the list by sending it back would send every server without its
 * environment and silently strip it. Two rules close that:
 *
 * - `mcpServerRemovals` names the owner-added servers to remove. Every other
 *   server stays exactly as stored, environment included. A name that is no
 *   longer stored is already removed, so a repeated removal changes nothing.
 * - A resent `mcpServers` entry without `env`, for a name stored with one, is
 *   refused rather than read as "clear it": an owner who means that sends
 *   `env: {}`. Absent `mcpServers` keeps the stored list, as it always has.
 *
 * Undefined means "keep the stored list".
 */
export const requestedMcpServers = (
  stored: readonly ExecutorLocalMcpServer[] | undefined,
  input: { mcpServers?: readonly ExecutorLocalMcpServer[]; mcpServerRemovals?: readonly string[] },
): ExecutorLocalMcpServer[] | undefined => {
  const saved = stored ?? []
  if (input.mcpServers !== undefined && input.mcpServerRemovals !== undefined) {
    throw new Error('Send the local MCP servers to keep, or the ones to remove, not both.')
  }
  if (input.mcpServerRemovals !== undefined) {
    const removals = new Set(input.mcpServerRemovals)
    for (const name of removals) {
      if (!ExecutorMcpServerNameSchema.safeParse(name).success) throw new Error('A local MCP server to remove is named by its name.')
      const server = saved.find((entry) => entry.name === name)
      // Discovered apps are switched off (mcpPolicy.disabled); the bridge follows codingSessions.
      if (server && (server.source !== undefined || name === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME)) {
        throw new Error(`${name} was not added by the owner, so it is switched off rather than removed.`)
      }
    }
    return saved.filter((server) => !removals.has(server.name))
  }
  if (input.mcpServers === undefined) return undefined
  for (const server of input.mcpServers) {
    const previous = saved.find((entry) => entry.name === server.name)
    if (server.env === undefined && previous?.env !== undefined && Object.keys(previous.env).length > 0) {
      throw new Error(`Sending ${server.name} without its environment would delete it. `
        + 'Remove servers with mcpServerRemovals, or send env: {} to clear it.')
    }
  }
  return [...input.mcpServers]
}
