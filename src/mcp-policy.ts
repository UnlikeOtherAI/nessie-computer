import { executorMcpServerNameIsLegal } from '@nessie/executor-protocol'

/**
 * Which local apps (MCP servers) a team may use (contract §4.5).
 *
 * - `installed`: every server discovered on this computer
 *   (`local-app-discovery.ts`) plus every server the owner named, minus the
 *   discovered ones in `disabled`. A new pairing writes this.
 * - `listed`: only the servers the owner named — what every connection paired
 *   before this policy existed reads as, so their reviewed set never grows by
 *   itself.
 *
 * `disabled` switches off a discovered server by name. An owner-named server
 * is removed by removing it from the list instead, because its launch spec
 * exists only there.
 */
export type LocalMcpPolicy = {
  mode: 'installed' | 'listed'
  disabled: string[]
}

/** Enough room for every app on a busy computer; a list past it is not something a person wrote. */
const DISABLED_MAXIMUM = 64

/** What a new pairing writes. */
export const pairedLocalMcpPolicy = (): LocalMcpPolicy => ({ mode: 'installed', disabled: [] })

/** What a connection with no saved policy reads as: the servers it names, nothing discovered. */
export const listedLocalMcpPolicy = (): LocalMcpPolicy => ({ mode: 'listed', disabled: [] })

export const parseLocalMcpPolicy = (value: unknown): LocalMcpPolicy => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local apps policy.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).sort().join(',') !== 'disabled,mode'
    || (input.mode !== 'installed' && input.mode !== 'listed')
    || !Array.isArray(input.disabled) || input.disabled.length > DISABLED_MAXIMUM
    || input.disabled.some((name) => typeof name !== 'string' || !executorMcpServerNameIsLegal(name))) {
    throw new Error('Invalid local apps policy.')
  }
  const disabled = input.disabled as string[]
  if (new Set(disabled).size !== disabled.length) throw new Error('List each switched-off local app once.')
  return { mode: input.mode, disabled: [...disabled].sort() }
}

export const localMcpPolicyOf = (state: { mcpPolicy?: LocalMcpPolicy }): LocalMcpPolicy => (
  state.mcpPolicy ? parseLocalMcpPolicy(state.mcpPolicy) : listedLocalMcpPolicy()
)

/** The two operations that reach a local app; offered together or not at all. */
export const MCP_OPERATION_KEYS = ['mcp.tools', 'mcp.call'] as const
