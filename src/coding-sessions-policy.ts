import { executorChildCommand } from './executor-child-command.js'
import { dirname, join, resolve } from 'node:path'

import {
  canonicalExecutorJson,
  EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  ExecutorCodingSessionsFactsSchema,
  type ExecutorCodingSessionsFacts,
} from '@nessie/executor-protocol'

import {
  CODING_SESSIONS_CONFIG_DIGEST_ENV,
  CodingSessionConfigError,
  codingSessionsConfigDigest,
  loadCodingSessionsConfig,
  normalizeCodingSessionsConfig,
  offeredCodingAgents,
  type CodingSessionsConfig,
} from './coding-session/config.js'
import { resolveExecutorEntry } from './coding-session/host-spawn.js'
import { claudeMergeCommands, claudeUnaskedCommands } from './coding-session/merge-commands.js'
import { canonicalOrDeclared, codingPathsOverlap, resolveCodingRoots } from './coding-session/roots.js'
import { assertExecutorLocalMcpServers, type ExecutorLocalMcpServer } from './mcp-servers.js'
import { replaceOwnerOnlyJson } from './owner-only-json.js'
import type { ExecutorWorkspaceFolder } from './workspace-folders.js'

/**
 * The owner's `codingSessions` object from `configure`, turned into the three
 * things the executor keeps: the host-local configuration file, written
 * owner-only into the executor's own state directory; the `coding-sessions`
 * named server, which the executor generates itself rather than accepting from
 * anyone; and the power facts that go into the signed descriptor, inside
 * `localPolicyDigest`, so a person reviews what the bridge may do before it
 * can do it. The bridge is started with the reviewed config digest in its
 * environment and refuses to start an agent while the file says anything else.
 *
 * A root is refused when it overlaps a workspace folder (those are read-only
 * and copy-on-write for every other operation), the executor's state
 * directory, the bridge's state directory or the configuration file. A coding
 * agent acts with the host user's full authority, and one that could write its
 * own configuration, another session's inbox or the machine key would be able
 * to widen or impersonate everything the review stands for.
 */

export const CODING_SESSIONS_CONFIG_FILE = 'coding-sessions.json'

export const codingSessionsConfigPath = (stateDir: string): string => (
  join(resolve(stateDir), CODING_SESSIONS_CONFIG_FILE)
)

/** How this executor starts itself; injectable so the generated argv is testable. */
export type ExecutorRuntime = {
  entry: string
  execArgv: readonly string[]
  execPath: string
  packaged: boolean
}

const currentRuntime = (): ExecutorRuntime => ({
  entry: resolveExecutorEntry(),
  // A debugger flag would make every bridge fight the daemon for its port.
  execArgv: process.execArgv.filter((argument) => !/^--(inspect|debug)/u.test(argument)),
  execPath: process.execPath,
  packaged: process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1',
})

/**
 * Codex has no permission-mode flag; its standing power is chosen by the
 * reviewed arguments, so the fact names the stance they take.
 */
const codexStance = (args: readonly string[]): string => {
  if (args.includes('--dangerously-bypass-approvals-and-sandbox') || args.includes('--yolo')) return 'bypassApprovalsAndSandbox'
  if (args.includes('--full-auto')) return 'fullAuto'
  if (args.includes('--approve-for-me')) return 'approveForMe'
  const flag = args.findIndex((argument) => argument === '--sandbox' || argument === '-s')
  const sandbox = flag >= 0 ? args[flag + 1] : args.find((argument) => argument.startsWith('--sandbox='))?.slice(10)
  return sandbox && /^[a-z][a-z-]{0,40}$/u.test(sandbox) ? `sandbox:${sandbox}` : 'default'
}

/**
 * A terminal is always offered, with the host user's authority: it starts the
 * program an agent names when this computer's command rules permit it, which
 * `terminalCommands` states. Those rules stay on the machine.
 */
export const codingSessionsFacts = (
  config: CodingSessionsConfig, configDigest: string,
): ExecutorCodingSessionsFacts => {
  const agents = offeredCodingAgents(config)
  return ExecutorCodingSessionsFactsSchema.parse({
    serverName: EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
    existingSessions: true,
    agents,
    permissionMode: Object.fromEntries(agents.map((agent) => [
      agent, agent === 'terminal' ? 'hostUser'
        : agent === 'claude' ? config.agents.claude!.permissionMode ?? 'default' : codexStance(config.agents.codex!.args),
    ])),
    allowedToolCount: config.agents.claude?.allowedTools.length ?? 0,
    environmentNames: [...new Set([...Object.keys(config.agentEnv.set), ...config.agentEnv.pass])].sort(),
    rootNames: config.roots.map((root) => root.name).sort(),
    configDigest,
    // Only Claude Code is given the budget; nothing bounds a Codex turn.
    maxBudgetUsd: Object.fromEntries(agents.map((agent) => [
      agent, agent === 'claude' ? config.maxBudgetUsd ?? null : null,
    ])),
    maxLiveSessionsPerOwner: config.maxLiveSessionsPerOwner,
    mergeCommands: claudeMergeCommands(config.agents.claude),
    // Standing machine access needs its author's "run any command" tick for `any`.
    unaskedCommands: claudeUnaskedCommands(config.agents.claude),
    terminalCommands: 'commandRules',
  })
}

/** The one launch spec `coding-sessions` may have: this executor's own entry, pinned to the reviewed digest. */
export const codingSessionsServer = (
  configPath: string, configDigest: string, runtime: ExecutorRuntime = currentRuntime(),
): ExecutorLocalMcpServer => ({
  name: EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  command: executorChildCommand(runtime, ['serve-coding-session-mcp', '--config', configPath]),
  cwd: dirname(runtime.entry),
  env: {
    [CODING_SESSIONS_CONFIG_DIGEST_ENV]: configDigest,
    ...(runtime.packaged ? { NESSIE_EXECUTOR_PACKAGED_CLI: '1' } : {}),
  },
})

/** True for the server `codingSessionsServer` generated: the name alone never makes a program the bridge. */
export const isBuiltinCodingSessionsServer = (server: ExecutorLocalMcpServer): boolean => {
  const serve = server.command.indexOf('serve-coding-session-mcp')
  return server.name === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME
    && serve > 0
    && server.command[serve + 1] === '--config'
    && server.command.length === serve + 3
    && typeof server.env?.[CODING_SESSIONS_CONFIG_DIGEST_ENV] === 'string'
}

/** Only this running, verified runtime's generated bridge is safe passive control code. */
export const isTrustedCodingControlBridge = (
  server: ExecutorLocalMcpServer, runtime?: ExecutorRuntime,
): boolean => {
  if (!isBuiltinCodingSessionsServer(server)) return false
  let verifiedRuntime: ExecutorRuntime
  try { verifiedRuntime = runtime ?? currentRuntime() } catch { return false }
  try {
    const generated = codingSessionsServer(
      server.command.at(-1)!, server.env![CODING_SESSIONS_CONFIG_DIGEST_ENV]!, verifiedRuntime,
    )
    return server.cwd === generated.cwd && server.command.length === generated.command.length
      && server.command.every((argument, index) => argument === generated.command[index])
  } catch { return false }
}

/** The configuration file the generated server reads, from its own argv. */
export const codingSessionsServerConfigPath = (server: ExecutorLocalMcpServer): string | undefined => (
  isBuiltinCodingSessionsServer(server) ? server.command.at(-1) : undefined
)

/**
 * The servers with the built-in bridge launched by `runtime`. A stored bridge
 * names the runtime that configured it, and an update, a renamed runtime or a
 * moved app leaves that path pointing at nothing; the bridge is this executor's
 * own entry, so it always starts on the runtime that is serving. Its reviewed
 * configuration file and digest are kept as they are.
 */
export const withBridgeOnRuntime = (
  servers: readonly ExecutorLocalMcpServer[], runtime: ExecutorRuntime = currentRuntime(),
): ExecutorLocalMcpServer[] => servers.map((server) => {
  const configPath = codingSessionsServerConfigPath(server)
  return configPath === undefined
    ? server
    : codingSessionsServer(configPath, server.env![CODING_SESSIONS_CONFIG_DIGEST_ENV]!, runtime)
})

/**
 * Refuses a root that overlaps a workspace folder, the executor state
 * directory, the bridge state directory or the configuration file, comparing
 * canonical paths the way the host's filesystem compares names. Every root
 * must exist now: a person naming a folder names one they can see.
 */
export const assertCodingRootsClear = async (input: {
  config: CodingSessionsConfig
  configPath: string
  stateDir: string
  workspaceFolders: readonly ExecutorWorkspaceFolder[]
}): Promise<void> => {
  const bridgeStateDir = join(dirname(input.configPath), 'coding-sessions')
  // Roots overlapping the bridge state, the config file or each other are the
  // bridge's own refusals; asking it here keeps one reading of those rules.
  const resolved = await resolveCodingRoots({
    config: input.config, configPath: input.configPath, digest: '', stateDir: bridgeStateDir,
  })
  const missing = resolved.roots.find((root) => root.canonical === undefined)
  if (missing) throw new CodingSessionConfigError(`The coding root "${missing.name}" must be an existing ordinary directory.`)
  const guarded: { label: string; paths: string[] }[] = [
    { label: 'the executor state directory', paths: [resolve(input.stateDir), await canonicalOrDeclared(input.stateDir)] },
    { label: 'the coding-sessions state directory', paths: [bridgeStateDir, await canonicalOrDeclared(bridgeStateDir)] },
    { label: 'the coding-sessions configuration file', paths: [input.configPath, await canonicalOrDeclared(input.configPath)] },
    ...input.workspaceFolders.map((folder) => ({
      label: `the workspace folder "${folder.name}"`, paths: [folder.path],
    })),
  ]
  for (const root of resolved.roots) {
    const spellings = [resolve(root.declared), root.canonical!]
    const clash = guarded.find((entry) => entry.paths.some((path) => (
      spellings.some((spelling) => codingPathsOverlap(spelling, path))
    )))
    if (clash) throw new CodingSessionConfigError(`The coding root "${root.name}" overlaps ${clash.label}.`)
  }
}

export type CodingSessionsPolicy = { facts: ExecutorCodingSessionsFacts; server: ExecutorLocalMcpServer }

/** How `configure` is told about the bridge, and the two seams its tests use. */
export type CodingSessionsRequest = {
  /** An object configures the bridge, `null` withdraws it, absent keeps it. */
  requested?: unknown
  runtime?: ExecutorRuntime
  writeConfig?: (path: string, value: unknown) => Promise<void>
}

type PlanInput = CodingSessionsRequest & {
  current: { facts?: ExecutorCodingSessionsFacts; servers?: readonly ExecutorLocalMcpServer[] }
  /** The servers a person named for this revision (the state's, when they named none). */
  mcpServers: readonly ExecutorLocalMcpServer[]
  stateDir: string
  workspaceFolders: readonly ExecutorWorkspaceFolder[]
}

const nothingToWrite = async (): Promise<void> => undefined

const chosenPolicy = async (
  input: PlanInput, previous: CodingSessionsPolicy | undefined,
): Promise<{ policy: CodingSessionsPolicy | undefined; write: () => Promise<void> }> => {
  const configPath = codingSessionsConfigPath(input.stateDir)
  const { stateDir, workspaceFolders } = input
  if (input.requested === null || (input.requested === undefined && !previous)) {
    return { policy: undefined, write: nothingToWrite }
  }
  if (input.requested === undefined) {
    const kept = await loadCodingSessionsConfig(codingSessionsServerConfigPath(previous!.server) ?? configPath)
      .catch(() => undefined)
    // A file edited since its review is not re-checked here: the bridge refuses it outright.
    if (kept?.digest === previous!.facts.configDigest) {
      await assertCodingRootsClear({ config: kept.config, configPath: kept.configPath, stateDir, workspaceFolders })
    }
    return { policy: previous, write: nothingToWrite }
  }
  // The file holds what the owner wrote; the digest is over its normalised
  // form, which is exactly what the bridge computes when it loads the file.
  const file = JSON.parse(JSON.stringify({ codingSessions: input.requested })) as unknown
  const config = normalizeCodingSessionsConfig(file)
  await assertCodingRootsClear({ config, configPath, stateDir, workspaceFolders })
  const digest = codingSessionsConfigDigest(config)
  return {
    policy: {
      facts: codingSessionsFacts(config, digest),
      server: codingSessionsServer(configPath, digest, input.runtime),
    },
    write: () => (input.writeConfig ?? replaceOwnerOnlyJson)(configPath, file),
  }
}

/**
 * What `configure` does with `codingSessions`: an object replaces the
 * configuration (validated, checked against every guarded path, and its
 * server and facts regenerated); `null` withdraws the bridge; absent keeps
 * the reviewed bridge as it is, re-checking its roots against the folders this
 * revision names. `servers` is every named server the revision fronts, the
 * generated bridge last. Nothing is written until the caller has accepted the
 * whole policy and calls `persist` with its operations.
 */
export const planCodingSessions = async (input: PlanInput): Promise<{
  facts?: ExecutorCodingSessionsFacts
  servers: ExecutorLocalMcpServer[]
  persist: (operationKeys: readonly string[]) => Promise<void>
}> => {
  const previous = codingSessionsPolicyOf(input.current.facts, input.current.servers)
  const { policy, write } = await chosenPolicy(input, previous)
  const servers = [...assertExecutorLocalMcpServers([
    ...namedServersWithoutBridge(input.mcpServers, previous),
    ...(policy ? [policy.server] : []),
  ])]
  return {
    ...(policy ? { facts: policy.facts } : {}),
    servers,
    persist: async (operationKeys) => {
      if (policy && !operationKeys.includes('mcp.call')) {
        throw new Error('Coding sessions are reached through mcp.tools and mcp.call; enable both to offer them.')
      }
      await write()
    },
  }
}

/**
 * The generated server and the descriptor's facts are written together and
 * read together. One without the other, a digest that differs between them, or
 * a `coding-sessions` entry that is not this executor's own bridge, is a
 * hand-edited state file; the fail-closed answer is to refuse it.
 */
export const codingSessionsStateIsConsistent = (
  facts: ExecutorCodingSessionsFacts | undefined,
  servers: readonly ExecutorLocalMcpServer[] | undefined,
): boolean => {
  const server = servers?.find((entry) => entry.name === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME)
  if (!facts || !server) return !facts && !server
  return ExecutorCodingSessionsFactsSchema.safeParse(facts).success
    && isBuiltinCodingSessionsServer(server)
    && server.env?.[CODING_SESSIONS_CONFIG_DIGEST_ENV] === facts.configDigest
}

/** The reviewed bridge a state names, when it names one. */
export const codingSessionsPolicyOf = (
  facts: ExecutorCodingSessionsFacts | undefined,
  servers: readonly ExecutorLocalMcpServer[] | undefined,
): CodingSessionsPolicy | undefined => {
  const server = servers?.find((entry) => entry.name === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME)
  return facts && server && codingSessionsStateIsConsistent(facts, servers) ? { facts, server } : undefined
}

/**
 * The servers a person named, with the reserved name refused. The generated
 * entry itself round-trips through `configure` unchanged — that is how an
 * omitted list keeps it — so only a *different* `coding-sessions` is refused.
 */
export const namedServersWithoutBridge = (
  requested: readonly ExecutorLocalMcpServer[],
  previous: CodingSessionsPolicy | undefined,
): ExecutorLocalMcpServer[] => requested.filter((server) => {
  if (server.name !== EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME) return true
  if (previous && canonicalExecutorJson(server) === canonicalExecutorJson(previous.server)) return false
  throw new Error(
    `The MCP server name "${EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME}" is reserved for the executor's own bridge; `
    + 'configure it through codingSessions instead.',
  )
})
