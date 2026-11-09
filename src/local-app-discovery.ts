import { constants } from 'node:fs'
import { access, lstat, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

import {
  EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  EXECUTOR_KELPIE_MCP_SERVER_NAME,
  executorMcpServerNameIsLegal,
} from '@nessie/executor-protocol'

import { absoluteDirectory, resolveProgramPath } from './coding-session/program-path.js'
import { claudeDeclaredLocalApps, type DeclaredLocalApp } from './local-app-discovery-claude.js'
import { codexDeclaredLocalApps } from './local-app-discovery-codex.js'
import { assertExecutorLocalMcpServers, type ExecutorLocalMcpServer, type LocalAppSource } from './mcp-servers.js'

/**
 * The local apps (stdio MCP servers) installed on this computer, for the
 * `installed` local-apps policy (`mcp-policy.ts`):
 *
 * 1. UnlikeOtherAI's own servers this executor knows how to start — Kelpie,
 *    as `kelpie mcp`, when the `kelpie` command is on PATH.
 * 2. The user-scope stdio servers in Claude Code's `~/.claude.json`.
 * 3. The stdio servers in Codex's `config.toml`.
 *
 * T3 Code keeps no MCP server list of its own: its agents are Claude Code and
 * Codex, and they read the two files above.
 *
 * Each server is checked as an owner-named one would be: its name in Nessie's
 * grammar (`node_repl` becomes `node-repl`; a name that still does not fit is
 * left out), its argv, environment and working directory within the policy's
 * bounds. A program found on PATH is stored as its absolute path, so the
 * server starts the file discovery found rather than whatever a later lookup
 * finds; one found nowhere is reported as not installed and never started.
 * The first source to claim a name keeps it, in the order above, and no
 * discovered server may take the coding-sessions bridge's name.
 *
 * Launch specs, environments included, stay in the owner-only state file and
 * this computer's own `describe`; only the names reach Nessie.
 */
export type DiscoveredLocalApp = {
  /** Whether its program is on this computer now. Only an installed app is started. */
  installed: boolean
  server: ExecutorLocalMcpServer & { source: LocalAppSource }
}

export type LocalAppDiscoveryOptions = {
  /** Whose PATH, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` apply; the daemon's own by default. */
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  /** Reads one configuration file, `undefined` when it is absent or not a readable file. */
  readText?: (path: string) => Promise<string | undefined>
}

/** Claude Code's file also holds per-project history; anything larger is not one this reads. */
const CONFIGURATION_MAX_BYTES = 32 * 1024 * 1024

const KNOWN_UNLIKEOTHERAI_APPS = [
  { name: EXECUTOR_KELPIE_MCP_SERVER_NAME, program: 'kelpie', args: ['mcp'] },
] as const

const readConfiguration = async (path: string): Promise<string | undefined> => {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > CONFIGURATION_MAX_BYTES) return undefined
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** A configured name in Nessie's MCP server grammar, or `undefined` when it cannot be one. */
export const localAppName = (declared: string): string | undefined => {
  const name = declared.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40)
    .replace(/-+$/u, '')
  return executorMcpServerNameIsLegal(name) ? name : undefined
}

/**
 * Whether an absolute program path is there to start. On Windows an app
 * execution alias (under `%LOCALAPPDATA%\Microsoft\WindowsApps`, how Store
 * apps put a command on PATH) is a link that `stat` is refused (EACCES) but
 * CreateProcess starts, so such a link counts; a dangling one (ENOENT) does not.
 */
const runnableFile = async (path: string, platform: NodeJS.Platform): Promise<boolean> => {
  if (platform === 'win32') {
    return stat(path).then((info) => info.isFile(), async (error: NodeJS.ErrnoException) => (
      error.code === 'EACCES' && lstat(path).then((info) => info.isSymbolicLink(), () => false)
    ))
  }
  if (!await stat(path).then((info) => info.isFile(), () => false)) return false
  return access(path, constants.X_OK).then(() => true, () => false)
}

/**
 * Where a server's program is: an absolute path that exists, or a bare name on
 * the absolute entries of PATH — on Windows also as the `.cmd` shim npm
 * installs, which the MCP transport starts through its interpreter.
 */
const locateProgram = async (
  program: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform,
): Promise<string | undefined> => {
  if (absoluteDirectory(program, platform)) return await runnableFile(program, platform) ? program : undefined
  const found = await resolveProgramPath(program, env, platform)
  if (found || platform !== 'win32' || win32.extname(program)) return found
  return resolveProgramPath(`${program}.cmd`, env, platform)
}

/** The configuration directory a variable names, when it names an absolute one. */
const directoryFrom = (value: string | undefined, platform: NodeJS.Platform): string | undefined => (
  value && absoluteDirectory(value, platform) ? value : undefined
)

export const discoverLocalApps = async (options: LocalAppDiscoveryOptions = {}): Promise<DiscoveredLocalApp[]> => {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const read = options.readText ?? readConfiguration
  const path = platform === 'win32' ? win32 : posix
  const claudeDirectory = directoryFrom(env.CLAUDE_CONFIG_DIR, platform) ?? home
  const codexDirectory = directoryFrom(env.CODEX_HOME, platform) ?? path.join(home, '.codex')

  const declared: Array<{ source: LocalAppSource; app: DeclaredLocalApp }> = []
  for (const known of KNOWN_UNLIKEOTHERAI_APPS) {
    const program = await locateProgram(known.program, env, platform)
    if (program) declared.push({ source: 'unlikeotherai', app: { name: known.name, command: [program, ...known.args] } })
  }
  const claude = await read(path.join(claudeDirectory, '.claude.json'))
  for (const app of claude === undefined ? [] : claudeDeclaredLocalApps(claude)) declared.push({ source: 'claude-code', app })
  const codex = await read(path.join(codexDirectory, 'config.toml'))
  for (const app of codex === undefined ? [] : codexDeclaredLocalApps(codex)) declared.push({ source: 'codex', app })

  const taken = new Set<string>([EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME])
  const discovered: DiscoveredLocalApp[] = []
  for (const { source, app } of declared) {
    const name = localAppName(app.name)
    if (!name || taken.has(name)) continue
    const [program, ...args] = app.command as [string, ...string[]]
    const located = await locateProgram(program, { ...env, ...app.env }, platform)
    const server: DiscoveredLocalApp['server'] = {
      name,
      command: [located ?? program, ...args],
      ...(app.cwd === undefined ? {} : { cwd: app.cwd }),
      ...(app.env === undefined ? {} : { env: { ...app.env } }),
      source,
    }
    try {
      assertExecutorLocalMcpServers([server])
    } catch {
      continue
    }
    taken.add(name)
    discovered.push({ installed: located !== undefined, server })
  }
  return discovered
}
