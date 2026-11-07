import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CODING_SESSIONS_CONFIG_DIGEST_ENV,
  codingSessionsConfigDigest,
  normalizeCodingSessionsConfig,
} from '../src/coding-session/config.js'
import type { ExecutorLocalMcpServer } from '../src/mcp-servers.js'
import { createExecutorMcpSessionManager, type ExecutorMcpSessionManager } from '../src/mcp-session-manager.js'

/**
 * A real coding-sessions bridge, driven through the daemon's own MCP session
 * manager, over a scratch git repository and the scripted coding agent. Every
 * answer the bridge gives is kept, so a suite can assert that none of them
 * ever carried a host path or account data.
 */
export const SCRIPTED_AGENT = fileURLToPath(new URL('./fixtures/scripted-coding-agent.mjs', import.meta.url))
const EXECUTOR_DIR = fileURLToPath(new URL('..', import.meta.url))
const EXECUTOR_ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url))

export const OWNER_A = 'owner-a-0123456789abcdef'
export const OWNER_B = 'owner-b-fedcba9876543210'

export type BridgeAnswer = { ok: boolean; body: Record<string, unknown>; code?: string }

/** `commandRules: null` sends none, as a bridge reached other than through the daemon would have. */
export type CallOptions = {
  owner?: string; command?: string; daemon?: true; commandRules?: Record<string, unknown> | null
}

export type CodingHarness = {
  dir: string
  root: string
  configPath: string
  stateDir: string
  recordDir: string
  outputs: string[]
  manager: ExecutorMcpSessionManager
  /** The bridge exactly as `manager` starts it, for a suite that stands in for the daemon. */
  server: ExecutorLocalMcpServer
  call: (tool: string, args: Record<string, unknown>, options?: CallOptions) => Promise<BridgeAnswer>
  /** Kills the bridge process; the next call starts a fresh one. */
  restartBridge: () => Promise<void>
  /** Grants or ends the daemon's lease that lets hosts put prompts to the owner (`owner-requests-lease.ts`). */
  ownerRequests: (live: boolean) => Promise<void>
  /** Ends a turn the scripted agent is holding with `#hold=<name>`. */
  release: (name: string) => Promise<void>
  agents: () => Promise<Record<string, unknown>[]>
  waitForStatus: (
    sessionId: string, accept: (body: Record<string, unknown>) => boolean, owner?: string, timeoutMs?: number,
  ) => Promise<Record<string, unknown>>
  cleanup: () => Promise<void>
}

const git = (cwd: string, args: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
  cwd, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
})

export const initRepository = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true })
  git(path, ['init', '-q', '-b', 'main'])
  await writeFile(join(path, 'README.md'), 'hello\n')
  git(path, ['add', 'README.md'])
  git(path, ['commit', '-q', '-m', 'initial'])
}

/**
 * A PATH that finds git and nothing else of note. The self-check runs
 * `gh auth status` whenever `gh` is installed, and CI runners have an
 * unauthenticated `gh`; leaving it off the agent's PATH keeps the suite
 * about the bridge rather than about the runner's GitHub login.
 */
const gitOnlyPath = async (dir: string): Promise<string> => {
  const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' })
    .split(/\r?\n/u).map((line) => line.trim()).find(Boolean)!
  if (process.platform === 'win32') return dirname(found)
  const bin = join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  await symlink(await realpath(found), join(bin, 'git'))
  return bin
}

const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms) })

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A live process's command line, or '' — how cleanup tells its own leftovers from a reused pid. */
const commandLineOf = (pid: number): string => {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true })
    }
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
    return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  } catch {
    return ''
  }
}

/**
 * Kills a leftover only while its command line still names what the test
 * started: Windows hands a dead pid to a new process within seconds, and a
 * cleanup that trusted the pid alone could kill anything on the machine.
 */
const killIfStill = (pid: number, marker: string): void => {
  if (alive(pid) && commandLineOf(pid).includes(marker)) process.kill(pid, 'SIGKILL')
}

export const waitUntil = async <T>(probe: () => Promise<T | undefined>, timeoutMs = 30_000, what = 'condition'): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await delay(150)
  }
}

export const createCodingHarness = async (options: {
  codingSessions?: Record<string, unknown>
  agentEnv?: Record<string, unknown>
  bridgeEnv?: Record<string, string>
  idleTimeoutMs?: number
  /** Passes the written config's own digest, as a daemon passes the reviewed one. */
  reviewedDigest?: true
  rootsInsideState?: true
  /** The daemon says Nessie reads requests, so hosts put prompts to the owner. */
  ownerRequests?: true
} = {}): Promise<CodingHarness> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nessie-coding-')))
  const root = join(dir, 'work')
  await initRepository(root)
  const recordDir = join(dir, 'record')
  await mkdir(recordDir)
  const configDir = join(dir, 'config')
  await mkdir(configDir)
  // Managed-session fixtures must never discover the developer's real provider sessions.
  await writeFile(join(configDir, 'existing-coding-sessions.json'), JSON.stringify({ enabled: false }))
  const configPath = join(configDir, 'coding-sessions.json')
  const agent = { command: [process.execPath, SCRIPTED_AGENT] }
  const agentEnv = options.agentEnv ?? { inheritUserSession: false }
  await writeFile(configPath, JSON.stringify({
    codingSessions: {
      roots: [{ name: 'work', path: options.rootsInsideState ? configDir : root }],
      agents: { claude: agent, codex: agent },
      idleMinutes: 5,
      maxTurnMinutes: 10,
      ...options.codingSessions,
      agentEnv: {
        ...agentEnv,
        set: {
          NESSIE_SCRIPTED_RECORD_DIR: recordDir,
          SCRIPTED_SET: 'from-config',
          PATH: await gitOnlyPath(dir),
          ...(agentEnv.set as Record<string, string> | undefined),
        },
      },
    },
  }))
  // The SDK strips nonstandard environment names. Preserve the runner's real
  // Windows ACL-helper context for this built-in bridge, as production does.
  const bridgeEnv = {
    ...(process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1' ? { NESSIE_EXECUTOR_PACKAGED_CLI: '1' } : {}),
    ...options.bridgeEnv,
  }
  if (options.reviewedDigest) {
    const written = normalizeCodingSessionsConfig(JSON.parse(await readFile(configPath, 'utf8')))
    bridgeEnv[CODING_SESSIONS_CONFIG_DIGEST_ENV] = codingSessionsConfigDigest(written)
  }
  const server: ExecutorLocalMcpServer = {
    name: 'coding-sessions',
    command: [process.execPath, '--import', 'tsx', EXECUTOR_ENTRY, 'serve-coding-session-mcp', '--config', configPath],
    cwd: EXECUTOR_DIR,
    env: bridgeEnv,
  }
  const manager = createExecutorMcpSessionManager([server], { maxResultBytes: 65_536 }, {
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
    log: () => undefined,
    startTimeoutMs: 30_000,
  })
  const outputs: string[] = []
  const call = async (
    tool: string, args: Record<string, unknown>, callOptions: CallOptions = {},
  ): Promise<BridgeAnswer> => {
    const meta: Record<string, unknown> = {
      'nessie/command': callOptions.command ?? randomUUID(),
      ...(callOptions.owner === '' ? {} : { 'nessie/owner': callOptions.owner ?? OWNER_A }),
      ...(callOptions.daemon ? { 'nessie/daemon-control': true } : {}),
      ...(callOptions.commandRules === null ? {}
        : { 'nessie/command-rules': callOptions.commandRules ?? { mode: 'all', allowlist: [], denylist: [] } }),
    }
    const result = await manager.callTool('coding-sessions', tool, args, meta) as {
      code?: string; content?: { text?: string }[]; success: boolean
    }
    const text = result.content?.[0]?.text
    if (typeof text !== 'string') return { ok: false, body: result as Record<string, unknown>, ...(result.code ? { code: result.code } : {}) }
    outputs.push(text)
    const body = JSON.parse(text) as Record<string, unknown>
    return { ok: result.success, body, ...(typeof body.code === 'string' ? { code: body.code } : {}) }
  }
  const agents = async (): Promise<Record<string, unknown>[]> => {
    const text = await readFile(join(recordDir, 'agents.jsonl'), 'utf8').catch(() => '')
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  }
  const stateDir = join(configDir, 'coding-sessions')
  // As the daemon writes it, but for the length of a suite rather than a minute.
  const ownerRequests = async (live: boolean): Promise<void> => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    await writeFile(join(stateDir, 'owner-requests.json'), JSON.stringify({ expiresAt: live ? Date.now() + 3_600_000 : 0 }))
  }
  if (options.ownerRequests) await ownerRequests(true)
  return {
    dir, root, configPath, stateDir, recordDir, outputs, manager, server, call, agents, ownerRequests,
    restartBridge: () => manager.stopAll(),
    release: (name) => writeFile(join(recordDir, `release-${name}`), ''),
    waitForStatus: async (sessionId, accept, owner = OWNER_A, timeoutMs = 30_000) => {
      // What the session last said, so a timeout names the status it stayed in.
      let last: unknown
      try {
        return await waitUntil(async () => {
          const answer = await call('session_status', { sessionId }, { owner })
          last = answer.body
          return answer.ok && accept(answer.body) ? answer.body : undefined
        }, timeoutMs, `session ${sessionId} to reach the expected status`)
      } catch (error) {
        throw new Error(`${(error as Error).message} It last read ${JSON.stringify(last)}.`, { cause: error })
      }
    },
    cleanup: async () => {
      await call('session_close_all', { reason: 'test_cleanup' }, { daemon: true, owner: '' }).catch(() => undefined)
      const sessions = join(stateDir, 'sessions')
      await waitUntil(async () => {
        const names = await readdir(sessions).catch(() => [] as string[])
        return names.every((name) => !existsSync(join(sessions, name, 'host.lock'))) ? true : undefined
      }, 20_000, 'every host to exit').catch(() => undefined)
      await manager.stopAll()
      const pids = new Set((await agents()).flatMap((entry) => (typeof entry.pid === 'number' ? [entry.pid] : [])))
      for (const pid of pids) killIfStill(pid, 'scripted-coding-agent')
      for (const name of await readdir(recordDir).catch(() => [] as string[])) {
        const match = /^grandchild-(\d+)\.pid$/u.exec(name)
        // The fixture's grandchild is `node -e "setTimeout(() => {}, 600000)"`.
        if (match) killIfStill(Number(match[1]), '600000')
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    },
  }
}
