import type { ExecutorCodingSessionsFacts, FolderSyncDescription } from '@nessie/executor-protocol'

import { codingSessionsPolicyOf, codingSessionsServerConfigPath } from './coding-sessions-policy.js'
import type { ExecutorLocalState } from './state-store.js'
import { localCommandPolicyOf, type LocalCommandPolicy } from './command-policy.js'
import { allowedOriginsOf } from './configuration-input.js'
import { discoverLocalApps, type DiscoveredLocalApp, type LocalAppDiscoveryOptions } from './local-app-discovery.js'
import { describeLocalApps, type LocalAppDescription } from './local-mcp-apps.js'
import { localMcpPolicyOf, type LocalMcpPolicy } from './mcp-policy.js'
import type { LocalAppSource } from './mcp-servers.js'
import { programDefaults, type ProgramDefault } from './program-trust.js'

/**
 * What this executor is allowed to reach and run, as one credential-free
 * answer. The menu bar app renders exactly this, and a headless operator reads
 * the same JSON over SSH — neither has to open the state file and neither
 * becomes a second interpretation of the policy.
 *
 * The machine key never appears here. It is the one field in the local state a
 * reader of this projection must never receive, so the shape is built field by
 * field rather than by removing keys from the state.
 *
 * Host paths do appear, unlike in the descriptor: this answer stays on the
 * machine, and the person reading it is the person whose directories these are.
 */
export type ExecutorDescription = {
  /** The effective program rules, `trusted` included when the connection has it. */
  commandPolicy: LocalCommandPolicy
  /** The built-in Programs entries, for the app to draw beside `commandPolicy.trusted`. */
  programDefaults: ProgramDefault[]
  /** The effective local-apps policy; `listed` for a connection that never chose one. */
  mcpPolicy: LocalMcpPolicy
  /** Every local app this computer knows of for the team, and whether the team may use it. */
  localApps: LocalAppDescription[]
  apiBaseUrl: string
  executorId: string
  policy: {
    limits: ExecutorLocalState['descriptor']['limits']
    operations: string[]
    /** Legacy descriptor projection. commandPolicy is authoritative for local launch decisions. */
    permittedPrograms: string[]
    profiles: string[]
    revision: number
    /**
     * The folder names the last proposed revision names. Empty means the
     * descriptor predates named folders and stands for the single folder below.
     */
    workspaceFolders: string[]
    /**
     * The local MCP servers the last proposed revision names. Empty means this
     * executor fronts none and refuses `mcp.tools` and `mcp.call` outright.
     */
    mcpServers: string[]
    /**
     * What the built-in coding-sessions bridge may do, exactly as the signed
     * descriptor states it. Absent when this executor does not offer it.
     */
    codingSessions?: ExecutorCodingSessionsFacts
  }
  reach: {
    /**
     * The websites (HTTPS origins) the guest browser may open, chosen with or
     * without the browser set up; `sandbox.browserConfigured` says whether it
     * can open them yet.
     */
    allowedOrigins: string[]
    /**
     * The read-only host folders this executor is paired against, by the name
     * that starts every workspace path an agent writes.
     */
    folders: Array<{ name: string; path: string }>
    /**
     * Whether a guest VM session can start at all. A guest mounts one
     * workspace, so `command.run` and `coding.launch` refuse outright while
     * more than one folder is configured; see `guestSessionFolder`.
     */
    guestSessions: 'available' | 'refused_multiple_folders'
    /**
     * How each named MCP server starts on this machine. The argv appears here
     * for the same reason folder paths do — this answer never leaves the host,
     * and the person reading it is the person who approved the program.
     */
    mcpServers: Array<{ command: string[]; cwd?: string; name: string; source?: LocalAppSource }>
    /** The coding-sessions bridge's host-local configuration file, when it is offered. */
    codingSessionsConfig?: string
  }
  /**
   * Folder sync on this connection (`folder-sync/config.json` and the engine's
   * last status), added by the `describe` command; the policy above never
   * includes it, because sync is not an agent capability.
   */
  folderSync?: FolderSyncDescription
  sandbox: {
    browserConfigured: boolean
    codingConfigured: boolean
    promotionHelperConfigured: boolean
  }
}

/**
 * Without `localApps` (a fresh discovery), the discovered apps the state
 * already fronts stand in for what is installed; {@link describeExecutorWithLocalApps}
 * looks first.
 */
export const describeExecutor = (
  state: ExecutorLocalState,
  options: { localApps?: readonly DiscoveredLocalApp[]; platform?: NodeJS.Platform } = {},
): ExecutorDescription => {
  const bridge = codingSessionsPolicyOf(state.descriptor.codingSessions, state.mcpServers)
  const bridgeConfig = bridge ? codingSessionsServerConfigPath(bridge.server) : undefined
  return {
    commandPolicy: localCommandPolicyOf(state),
    programDefaults: programDefaults(options.platform),
    mcpPolicy: localMcpPolicyOf(state),
    localApps: describeLocalApps(state, options.localApps),
    apiBaseUrl: state.apiBaseUrl,
    executorId: state.executorId,
    policy: {
      limits: { ...state.descriptor.limits },
      operations: [...state.descriptor.operationKeys],
      permittedPrograms: [...(state.descriptor.commandAllowlist ?? [])],
      profiles: [...state.descriptor.profiles],
      revision: state.descriptor.revision,
      workspaceFolders: [...(state.descriptor.workspaceFolders ?? [])],
      mcpServers: [...(state.descriptor.mcpServers ?? [])],
      ...(bridge ? { codingSessions: bridge.facts } : {}),
    },
    reach: {
      allowedOrigins: allowedOriginsOf(state),
      folders: [...state.workspaceFolders]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((folder) => ({ name: folder.name, path: folder.path })),
      guestSessions: state.workspaceFolders.length === 1 ? 'available' : 'refused_multiple_folders',
      mcpServers: [...(state.mcpServers ?? [])]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((server) => ({
          command: [...server.command],
          name: server.name,
          ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
          ...(server.source === undefined ? {} : { source: server.source }),
        })),
      ...(bridgeConfig ? { codingSessionsConfig: bridgeConfig } : {}),
    },
    sandbox: {
      browserConfigured: Boolean(state.browserSandbox),
      codingConfigured: Boolean(state.codexSandbox),
      promotionHelperConfigured: Boolean(state.nativeHelperPath),
    },
  }
}

/** `describe` as the CLI answers it: with this computer's local apps discovered first. */
export const describeExecutorWithLocalApps = async (
  state: ExecutorLocalState, options: LocalAppDiscoveryOptions = {},
): Promise<ExecutorDescription> => describeExecutor(state, {
  localApps: await discoverLocalApps(options),
  ...(options.platform ? { platform: options.platform } : {}),
})
