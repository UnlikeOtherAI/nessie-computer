import { isAbsolute } from 'node:path'

import {
  EXECUTOR_MCP_SERVER_MAXIMUM,
  ExecutorMcpServerNameSchema,
} from '@nessie/executor-protocol'

/**
 * One local MCP server the reviewed policy names, and how this host starts
 * it. The name is the only part that ever reaches Nessie (through the
 * descriptor); the launch spec — argv, working directory, environment — stays
 * in the owner-only state file for exactly the reason a workspace folder's
 * host path does: a reviewer approves a capability, not somebody's disk
 * layout. Error messages that leave the machine are built from the name and a
 * reason category, never from these fields.
 */
export type ExecutorLocalMcpServer = {
  /** The policy's handle for the server, e.g. `kelpie`. */
  name: string
  /** argv: program plus its arguments, exactly as passed to spawn. */
  command: string[]
  /** Working directory for the server process; absent means the daemon's. */
  cwd?: string
  /** Extra environment for the server process, over the SDK's safe default set. */
  env?: Record<string, string>
  /**
   * Where discovery found this server (`local-app-discovery.ts`). Absent means
   * the owner named it, or it is the executor's own coding-sessions bridge;
   * only a discovered entry is replaced when discovery runs again.
   */
  source?: LocalAppSource
}

/** Where an installed local app (MCP server) was found on this computer. */
export const LOCAL_APP_SOURCES = ['unlikeotherai', 'claude-code', 'codex'] as const
export type LocalAppSource = typeof LOCAL_APP_SOURCES[number]

export const isLocalAppSource = (value: unknown): value is LocalAppSource => (
  (LOCAL_APP_SOURCES as readonly unknown[]).includes(value)
)

export class ExecutorMcpServerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const EXECUTOR_MCP_COMMAND_MAXIMUM = 16
const EXECUTOR_MCP_ENV_MAXIMUM = 32

/**
 * Every rule a named-server set has to satisfy before it is stored or
 * enforced. As with workspace folders the names — never the launch specs —
 * decide identity, so a duplicate name is refused alongside the grammar
 * failures; there is no path arithmetic to confuse two servers into one.
 */
export const assertExecutorLocalMcpServers = (
  servers: readonly ExecutorLocalMcpServer[],
): readonly ExecutorLocalMcpServer[] => {
  if (servers.length > EXECUTOR_MCP_SERVER_MAXIMUM) {
    throw new ExecutorMcpServerError(
      'EXECUTOR_MCP_POLICY_INVALID',
      `A team may use at most ${EXECUTOR_MCP_SERVER_MAXIMUM} local apps (MCP servers).`,
    )
  }
  for (const server of servers) {
    if (!ExecutorMcpServerNameSchema.safeParse(server.name).success) {
      throw new ExecutorMcpServerError(
        'EXECUTOR_MCP_POLICY_INVALID',
        `An MCP server name is 1 to 40 lowercase letters, digits and interior hyphens — not "${
          server.name.slice(0, 80)
        }".`,
      )
    }
    if (
      server.command.length < 1
      || server.command.length > EXECUTOR_MCP_COMMAND_MAXIMUM
      || server.command.some((part) => typeof part !== 'string' || !part || part.includes('\0'))
    ) {
      throw new ExecutorMcpServerError(
        'EXECUTOR_MCP_POLICY_INVALID',
        `The MCP server "${server.name}" needs an argv of 1 to ${
          EXECUTOR_MCP_COMMAND_MAXIMUM
        } non-empty strings.`,
      )
    }
    if (server.cwd !== undefined && (!isAbsolute(server.cwd) || server.cwd.includes('\0'))) {
      throw new ExecutorMcpServerError(
        'EXECUTOR_MCP_POLICY_INVALID',
        `The MCP server "${server.name}" needs an absolute working directory.`,
      )
    }
    if (server.source !== undefined && !isLocalAppSource(server.source)) {
      throw new ExecutorMcpServerError(
        'EXECUTOR_MCP_POLICY_INVALID',
        `The MCP server "${server.name}" names a discovery source this policy does not know.`,
      )
    }
    if (server.env !== undefined) {
      const entries = Object.entries(server.env)
      if (
        entries.length > EXECUTOR_MCP_ENV_MAXIMUM
        || entries.some(([key, value]) => (
          !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0')
        ))
      ) {
        throw new ExecutorMcpServerError(
          'EXECUTOR_MCP_POLICY_INVALID',
          `The MCP server "${server.name}" has an environment entry this policy cannot carry.`,
        )
      }
    }
  }
  if (new Set(servers.map((server) => server.name)).size !== servers.length) {
    throw new ExecutorMcpServerError('EXECUTOR_MCP_POLICY_INVALID', 'Each MCP server is named once.')
  }
  return servers
}

/** The names the signed descriptor carries, in one canonical order. */
export const executorLocalMcpServerNames = (
  servers: readonly ExecutorLocalMcpServer[],
): string[] => servers.map((server) => server.name).sort()

/**
 * The launch spec a server name resolves to. This lookup — by name in the
 * configured list — is the only way a request reaches a launch spec, which is
 * what makes "call a server the policy did not name" unrepresentable rather
 * than merely refused.
 */
export const findExecutorLocalMcpServer = (
  servers: readonly ExecutorLocalMcpServer[],
  name: string,
): ExecutorLocalMcpServer => {
  const found = servers.find((server) => server.name === name)
  if (!found) {
    throw new ExecutorMcpServerError(
      'EXECUTOR_MCP_DENIED',
      servers.length === 0
        ? 'This team uses no local app (MCP server) — its reviewed policy names none.'
        : `This team's reviewed policy names no local app (MCP server) called "${name}".`,
    )
  }
  return found
}
