import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { canonicalExecutorJson, executorWorkspaceFolderNameIsLegal } from '@nessie/executor-protocol'

import { STRUCTURED_CODING_AGENT_NAMES, type CodingAgentName } from './types.js'

/**
 * The owner's host-local coding-sessions configuration: which coding agents
 * may run, where, and with what standing permissions.
 *
 * Every field is power, so the shape is closed: an unknown key is refused
 * rather than ignored, and the digest below covers the normalised form with
 * its defaults filled in. A newer build whose defaults differ therefore
 * produces a different digest, and the bridge refuses to start hosts until a
 * person has reviewed what that change means.
 */

/**
 * A `--permission-mode` value is only shaped here. Which modes exist is the
 * installed CLI's to say — 2.1.280 lists acceptEdits, auto, bypassPermissions,
 * manual, dontAsk and plan, and a newer one may list more — so the host's
 * self-check reads the choices from its `--help` before every start.
 */
const PERMISSION_MODE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u

/** The daemon passes the reviewed digest here; a mismatch stops every host start. */
export const CODING_SESSIONS_CONFIG_DIGEST_ENV = 'NESSIE_CODING_SESSIONS_CONFIG_DIGEST'

export type CodingAgentConfig = {
  command: string[]
  args: string[]
  permissionMode?: string
  allowedTools: string[]
  disallowedTools: string[]
  model?: string
}

export type CodingSessionsConfig = {
  existingSessions?: true
  roots: { name: string; path: string }[]
  /**
   * `terminal` appears only in a file an older build wrote, when a terminal
   * ran one configured program. It is read so that file keeps its reviewed
   * digest, is never used, and the daemon removes it when it starts
   * (`local-session-bridge.ts`).
   */
  agents: Partial<Record<CodingAgentName, CodingAgentConfig>>
  agentEnv: { inheritUserSession: boolean; pass: string[]; set: Record<string, string> }
  maxLiveSessionsPerOwner: number
  idleMinutes: number
  maxTurnMinutes: number
  maxBudgetUsd?: number
  /**
   * Whether the daemon closes every session when it shuts down. Off by
   * default: a session is meant to outlive a daemon restart, and the daemon
   * still closes them all whenever it loses its connection or is fenced.
   */
  closeOnDaemonShutdown: boolean
}

export type LoadedCodingSessionsConfig = {
  config: CodingSessionsConfig
  configPath: string
  digest: string
  /** Beside the config file, which the executor writes into its own owner-only state. */
  stateDir: string
}

export class CodingSessionConfigError extends Error {
  override readonly name = 'CodingSessionConfigError'
}

const MAX_CONFIG_BYTES = 64 * 1024
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/u

/**
 * Flags an agent's `args` and `command` may not carry, because each one
 * carries power the reviewed facts would not show — bypassing or widening
 * permissions, other directories, other settings or MCP servers — or would
 * break the protocol the bridge speaks. The typed fields (`permissionMode`,
 * `allowedTools`, `disallowedTools`, `model`) say the same things in a way
 * the review can show.
 */
const CLAUDE_REFUSED_FLAGS = [
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode',
  '--permission-prompts', '--permission-prompt-tool', '--allowedTools', '--allowed-tools', '--disallowedTools',
  '--disallowed-tools', '--tools', '--add-dir', '--settings', '--setting-sources', '--mcp-config', '--plugin-dir',
  '--plugin-url', '--agents', '--agent', '--chrome', '--remote-control', '--cloud', '--teleport', '--environment',
  '-p', '--print', '--input-format', '--output-format', '-r', '--resume', '-c', '--continue', '--session-id',
  '--fork-session', '--replay-user-messages', '--bg', '--background', '--append-system-prompt', '--system-prompt',
]

/**
 * Codex's power is the stance its sandbox and approval flags take, which the
 * facts name; a `-c` override, a profile or an added directory changes it
 * behind that name, and `-C`, `resume` and `--json` belong to the bridge.
 */
const CODEX_REFUSED_FLAGS = [
  '-c', '--config', '--enable', '--disable', '-p', '--profile', '--add-dir', '-C', '--cd',
  '--dangerously-bypass-hook-trust', '--ignore-rules', '--json', '-o', '--output-last-message',
]

const usesFlag = (argument: string, flag: string): boolean => (
  argument === flag
  || argument.startsWith(`${flag}=`)
  // A short option takes its value attached too: `-cmodel=o3`, `-C/dir`.
  || (/^-[A-Za-z]$/u.test(flag) && argument.startsWith(flag) && !argument.startsWith('--'))
)

const record = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

const refuse = (message: string): never => { throw new CodingSessionConfigError(message) }

const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[], where: string): void => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) refuse(`${where} has unknown keys: ${unknown.slice(0, 5).join(', ')}.`)
}

const stringList = (value: unknown, where: string, maximum: number, maxLength: number): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => (
    typeof entry !== 'string' || !entry || entry.length > maxLength || entry.includes('\0')
  ))) {
    return refuse(`${where} must be a list of at most ${maximum} non-empty strings.`)
  }
  return [...value] as string[]
}

const boundedNumber = (
  value: unknown, where: string, fallback: number | undefined, bounds: { min: number; max: number; integer?: true },
): number | undefined => {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= bounds.min || value > bounds.max
    || bounds.integer && !Number.isInteger(value)) {
    return refuse(`${where} must be a number above ${bounds.min} and at most ${bounds.max}.`)
  }
  return value
}

const agentConfig = (name: CodingAgentName, value: unknown): CodingAgentConfig => {
  const where = `codingSessions.agents.${name}`
  if (!record(value)) return refuse(`${where} must be an object.`)
  onlyKeys(value, name === 'claude'
    ? ['command', 'args', 'permissionMode', 'allowedTools', 'disallowedTools', 'model']
    : name === 'terminal' ? ['command', 'args'] : ['command', 'args', 'model'], where)
  const command = stringList(value.command, `${where}.command`, 8, 4_096)
  if (command.length === 0) refuse(`${where}.command names the program to run.`)
  // Without a shell nothing can run a script shim, and an npm shim only forwards to the real program.
  if (/\.(?:cmd|bat|ps1)$/iu.test(command[0]!)) {
    refuse(`${where}.command names a script shim; name the program itself (${name === 'claude' ? 'claude.exe' : 'node and codex.js'}).`)
  }
  const args = stringList(value.args, `${where}.args`, 32, 1_024)
  const refused = name === 'terminal' ? [] : name === 'claude' ? CLAUDE_REFUSED_FLAGS : CODEX_REFUSED_FLAGS
  for (const argument of [...command.slice(1), ...args]) {
    const flag = refused.find((entry) => usesFlag(argument, entry))
    if (flag) {
      refuse(`${where} may not pass ${flag}: say it through the reviewed fields, which the review shows, or not at all.`)
    }
    if (name === 'codex' && (argument === 'resume' || argument === 'exec')) {
      refuse(`${where} may not name the ${argument} subcommand; the bridge runs Codex itself.`)
    }
  }
  const permissionMode = value.permissionMode
  if (permissionMode !== undefined && (typeof permissionMode !== 'string' || !PERMISSION_MODE.test(permissionMode))) {
    refuse(`${where}.permissionMode must be a mode name, such as acceptEdits or plan.`)
  }
  if (value.model !== undefined && (typeof value.model !== 'string' || !MODEL_NAME.test(value.model))) {
    refuse(`${where}.model must be a model name or alias.`)
  }
  return {
    command,
    args,
    ...(permissionMode === undefined ? {} : { permissionMode: permissionMode as string }),
    allowedTools: stringList(value.allowedTools, `${where}.allowedTools`, 64, 200),
    disallowedTools: stringList(value.disallowedTools, `${where}.disallowedTools`, 64, 200),
    ...(value.model === undefined ? {} : { model: value.model as string }),
  }
}

const agentEnvironment = (value: unknown): CodingSessionsConfig['agentEnv'] => {
  if (value === undefined) return { inheritUserSession: true, pass: [], set: {} }
  if (!record(value)) return refuse('codingSessions.agentEnv must be an object.')
  onlyKeys(value, ['inheritUserSession', 'pass', 'set'], 'codingSessions.agentEnv')
  if (value.inheritUserSession !== undefined && typeof value.inheritUserSession !== 'boolean') {
    refuse('codingSessions.agentEnv.inheritUserSession must be true or false.')
  }
  const pass = stringList(value.pass, 'codingSessions.agentEnv.pass', 64, 128)
  if (pass.some((name) => !ENV_NAME.test(name))) refuse('codingSessions.agentEnv.pass names environment variables.')
  const set: Record<string, string> = {}
  if (value.set !== undefined) {
    if (!record(value.set) || Object.keys(value.set).length > 64) {
      refuse('codingSessions.agentEnv.set maps at most 64 variable names to values.')
    }
    for (const [name, entry] of Object.entries(value.set as Record<string, unknown>)) {
      if (!ENV_NAME.test(name) || typeof entry !== 'string' || entry.length > 4_096 || entry.includes('\0')) {
        refuse('codingSessions.agentEnv.set maps variable names to string values.')
      }
      set[name] = entry as string
    }
  }
  return { inheritUserSession: value.inheritUserSession !== false, pass, set }
}

const rootList = (value: unknown, allowEmpty = false): CodingSessionsConfig['roots'] => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 16) {
    return refuse('codingSessions.roots names between 1 and 16 folders.')
  }
  const roots = value.map((entry: unknown, index) => {
    if (!record(entry)) return refuse(`codingSessions.roots[${index}] must be an object.`)
    onlyKeys(entry, ['name', 'path'], `codingSessions.roots[${index}]`)
    if (typeof entry.name !== 'string' || !executorWorkspaceFolderNameIsLegal(entry.name)) {
      refuse(`codingSessions.roots[${index}].name is 1 to 40 lowercase letters, digits and interior hyphens.`)
    }
    if (typeof entry.path !== 'string' || !isAbsolute(entry.path) || entry.path.includes('\0')) {
      refuse(`codingSessions.roots[${index}].path must be an absolute directory.`)
    }
    return { name: entry.name as string, path: entry.path as string }
  })
  if (new Set(roots.map((root) => root.name)).size !== roots.length) refuse('codingSessions.roots names must be unique.')
  return roots
}

/** The agents a session may start: the configured Claude Code and Codex, and the built-in terminal. */
export const offeredCodingAgents = (config: CodingSessionsConfig): CodingAgentName[] => [
  ...STRUCTURED_CODING_AGENT_NAMES.filter((name) => config.agents[name] !== undefined), 'terminal',
]

/**
 * Validates the file's shape and fills every default, so the digest covers
 * what actually runs. `legacyTerminal` reads a file an older build wrote with
 * a configured terminal program, keeping its digest; a new configuration may
 * not name one, because a terminal starts the program the agent names.
 */
export const normalizeCodingSessionsConfig = (
  input: unknown, options: { legacyTerminal?: boolean } = {},
): CodingSessionsConfig => {
  if (!record(input)) return refuse('The coding-sessions configuration must be a JSON object.')
  onlyKeys(input, ['codingSessions'], 'The configuration')
  const value = input.codingSessions
  if (!record(value)) return refuse('The configuration needs a codingSessions object.')
  onlyKeys(value, [
    'roots', 'agents', 'agentEnv', 'maxLiveSessionsPerOwner', 'idleMinutes', 'maxTurnMinutes', 'maxBudgetUsd',
    'closeOnDaemonShutdown', 'existingSessions',
  ], 'codingSessions')
  if (value.existingSessions !== undefined && value.existingSessions !== true) refuse('existingSessions must be true.')
  if (value.closeOnDaemonShutdown !== undefined && typeof value.closeOnDaemonShutdown !== 'boolean') {
    refuse('codingSessions.closeOnDaemonShutdown must be true or false.')
  }
  if (!record(value.agents)) return refuse('codingSessions.agents must be an object; {} offers only terminal sessions.')
  if (value.agents.terminal !== undefined && !options.legacyTerminal) {
    refuse('codingSessions.agents.terminal is built in: a terminal session starts the program the agent names, '
      + 'when this computer\'s command rules permit it. Remove it.')
  }
  const names: readonly CodingAgentName[] = options.legacyTerminal
    ? [...STRUCTURED_CODING_AGENT_NAMES, 'terminal'] : STRUCTURED_CODING_AGENT_NAMES
  onlyKeys(value.agents, names, 'codingSessions.agents')
  const agents: CodingSessionsConfig['agents'] = {}
  for (const name of names) {
    if (value.agents[name] !== undefined) agents[name] = agentConfig(name, value.agents[name])
  }
  const structured = STRUCTURED_CODING_AGENT_NAMES.some((name) => agents[name] !== undefined)
  const maxBudgetUsd = boundedNumber(value.maxBudgetUsd, 'codingSessions.maxBudgetUsd', undefined, { min: 0, max: 1_000 })
  return {
    // Claude Code and Codex work in a named root; a terminal starts in any folder.
    roots: rootList(value.roots, value.existingSessions === true || !structured),
    ...(value.existingSessions === true ? { existingSessions: true as const } : {}),
    agents,
    agentEnv: agentEnvironment(value.agentEnv),
    maxLiveSessionsPerOwner: boundedNumber(value.maxLiveSessionsPerOwner, 'codingSessions.maxLiveSessionsPerOwner', 3, {
      min: 0, max: 20, integer: true,
    })!,
    idleMinutes: boundedNumber(value.idleMinutes, 'codingSessions.idleMinutes', 30, { min: 0, max: 1_440 })!,
    maxTurnMinutes: boundedNumber(value.maxTurnMinutes, 'codingSessions.maxTurnMinutes', 45, { min: 0, max: 1_440 })!,
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    closeOnDaemonShutdown: value.closeOnDaemonShutdown === true,
  }
}

/** The canonical text a reviewed descriptor's `configDigest` is computed over. */
export const canonicalCodingSessionsConfig = (config: CodingSessionsConfig): string => canonicalExecutorJson(config)

/**
 * Convert runtime defaults back to the closed, provider-specific configuration
 * input — without an older build's terminal program, which is not input any more.
 */
export const codingSessionsConfigInput = (config: CodingSessionsConfig): unknown => ({
  ...config,
  agents: Object.fromEntries(Object.entries(config.agents).filter(([name]) => name !== 'terminal').map(([name, agent]) => [name, {
    command: agent.command,
    args: agent.args,
    ...(name === 'claude' ? {
      permissionMode: agent.permissionMode,
      allowedTools: agent.allowedTools,
      disallowedTools: agent.disallowedTools,
    } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
  }])),
})

export const codingSessionsConfigDigest = (config: CodingSessionsConfig): string => (
  `sha256:${createHash('sha256').update(canonicalCodingSessionsConfig(config)).digest('hex')}`
)

/**
 * True when no reviewed digest was passed (a hand-run bridge), or when it
 * matches. Editing the file therefore changes nothing a daemon runs until a
 * person reviews the new digest.
 */
export const codingSessionsDigestMatches = (
  loaded: Pick<LoadedCodingSessionsConfig, 'digest'>,
  environment: NodeJS.ProcessEnv = process.env,
): boolean => {
  const reviewed = environment[CODING_SESSIONS_CONFIG_DIGEST_ENV]
  return reviewed === undefined || reviewed === '' || reviewed === loaded.digest
}

export const loadCodingSessionsConfig = async (configPath: string): Promise<LoadedCodingSessionsConfig> => {
  if (!isAbsolute(configPath)) refuse('The coding-sessions --config path must be absolute.')
  const info = await lstat(configPath).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink()) refuse('The coding-sessions --config path must be an ordinary file.')
  if (info!.size > MAX_CONFIG_BYTES) refuse('The coding-sessions configuration is too large.')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    return refuse('The coding-sessions configuration is not valid JSON.')
  }
  const config = normalizeCodingSessionsConfig(parsed, { legacyTerminal: true })
  return {
    config,
    configPath,
    digest: codingSessionsConfigDigest(config),
    stateDir: join(dirname(configPath), 'coding-sessions'),
  }
}
