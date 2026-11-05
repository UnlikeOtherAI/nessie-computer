import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import type { CodingProcessControl } from './coding-session/process-control.js'
import type { CodingProcessIdentity } from './coding-session/types.js'

/** Ordinary cancellation signals the visible tree; it supplies no credential-custody proof. */
export const cancelExecutorMcpProcessTree = async (
  transport: StdioClientTransport | undefined,
  control: CodingProcessControl,
  recorded?: CodingProcessIdentity,
): Promise<void> => {
  const pid = transport?.pid
  const identity = recorded ?? (pid ? await control.identify(pid) : undefined)
  if (identity) await control.killTree(identity)
}

/** Capture the tree before EOF or an MCP cancellation can let its root exit and hide descendants. */
export const stopExecutorMcpProcessTree = async (
  transport: StdioClientTransport | undefined,
  control: CodingProcessControl,
  recorded?: CodingProcessIdentity,
): Promise<void> => {
  const pid = transport?.pid
  const identity = recorded ?? (pid ? await control.identify(pid) : undefined)
  if (!identity || !control.stopTree || await control.stopTree(identity) !== 'stopped') {
    throw new Error('The local MCP process tree stop could not be proved.')
  }
}
