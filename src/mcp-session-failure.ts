import type { ExecutorMcpUnavailableReason } from '@nessie/executor-protocol'
import type { ExecutorMcpServerError } from './mcp-servers.js'

export type ExecutorMcpFailure = {
  code: string
  message: string
  /** A failed start names a recovery category, never its launch specification. */
  reason?: ExecutorMcpUnavailableReason
  success: false
}

export const failure = (code: string, message: string): ExecutorMcpFailure => ({ code, message, success: false })
export const denied = (error: ExecutorMcpServerError): ExecutorMcpFailure =>
  failure('EXECUTOR_MCP_DENIED', error.message)
export const unavailable = (message: string, reason?: ExecutorMcpUnavailableReason): ExecutorMcpFailure => ({
  code: 'EXECUTOR_MCP_UNAVAILABLE', message, ...(reason === undefined ? {} : { reason }), success: false,
})

/** Structural process evidence selects the same category used by public diagnostics. */
export const classifyStartFailure = (
  spawnError: (Error & { code?: string }) | undefined,
  exited: boolean,
): ExecutorMcpUnavailableReason => {
  if (spawnError?.code === 'ENOENT') return 'not_installed'
  if (exited) return 'launch_failed'
  return 'handshake_failed'
}

/** Safe, actionable diagnostics independent of the private program/argv/environment. */
export const startFailureMessage = (server: string, reason: ExecutorMcpUnavailableReason): string => {
  if (reason === 'not_installed') return `The MCP server "${server}" is not installed — its program was not found.`
  if (reason === 'launch_failed') return `The MCP server "${server}" exited during startup.`
  return `The MCP server "${server}" did not complete the MCP handshake.`
}
