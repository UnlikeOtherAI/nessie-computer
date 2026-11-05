import { win32 } from 'node:path'

import { agentVersionStamp, checkAgentCapabilities, readAgentCapabilities } from './agent-capabilities.js'
import { runCommand, type CommandRunner } from './agent-env.js'
import type { CodingAgentConfig } from './config.js'
import type { CodingAgentName } from './types.js'

/**
 * What a host proves before it starts an agent, each failure with its own
 * name because each sends the person to a different fix: install the CLI,
 * update it (`agent_outdated`: its `--help` lacks a flag the adapter passes),
 * try again (`agent_help_unreadable`: its `--help` did not answer in time),
 * name a permission mode it offers, log it in, install git, log `gh` in, or
 * run the executor as a person rather than as the Windows service's virtual
 * account (which has no Claude login and no user profile at all).
 *
 * The CLI's capabilities are read before its login, because a CLI too old for
 * `auth status` would otherwise read as logged out. Only exit codes, the help
 * text and the `loggedIn` flag are read. `claude auth status` also prints the
 * account's email and organisation, which never leave this function.
 */
export type CodingSelfCheckReason =
  | 'agent_missing'
  | 'agent_outdated'
  | 'agent_help_unreadable'
  | 'permission_mode_unsupported'
  | 'agent_not_logged_in'
  | 'git_missing'
  | 'gh_not_authenticated'
  | 'unsupported_supervisor'

export type CodingSelfCheckOutcome =
  /** `unverified` names what the CLI's help could not show either way, for the host's own log only. */
  | { ok: true; agentVersion?: string; unverified?: string[] }
  /** `missing` names what the CLI's help lacked, for the host's own log only. */
  | { ok: false; reason: CodingSelfCheckReason; missing?: string[] }

const VERSION_TEXT = /^[\w .()+-]{1,80}$/u

/**
 * The accounts a Windows service runs as: LocalSystem, LocalService,
 * NetworkService, and every virtual service account (`NT SERVICE\…`, which is
 * what the packaged `NessieExecutor` service uses). None of them is a person,
 * so none has a Claude login, a ChatGPT subscription or a user profile.
 */
const SERVICE_ACCOUNT_SID = /^S-1-5-(?:18|19|20|80(?:-\d+)+)$/u

/**
 * Whether this process runs as a service account, read from the token itself
 * rather than from the supervisor marker, which only a correctly configured
 * service sets. `whoami` is called by its absolute System32 path, so no PATH
 * entry can answer in its place; an answer it cannot read counts as a person,
 * because the login check that follows fails such an account anyway.
 */
export const runsAsWindowsServiceAccount = async (
  run: CommandRunner, received: NodeJS.ProcessEnv = process.env,
): Promise<boolean> => {
  const whoami = win32.join(received.SystemRoot ?? received.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'whoami.exe')
  const answer = await run(whoami, ['/user', '/fo', 'csv', '/nh'], { env: received })
  const sid = /"(S-1-[\d-]+)"\s*$/u.exec(answer.stdout.trim())?.[1]
  return sid !== undefined && SERVICE_ACCOUNT_SID.test(sid)
}

/**
 * Whether this host may run anything as a person at all: never under a
 * Windows service, whose account has no person's logins or profile and may be
 * a system account. Every program a host starts meets it — a coding agent in
 * its self-check below, a terminal before its program starts (`host.ts`).
 */
export const runsUnderWindowsService = async (input: {
  platform?: NodeJS.Platform
  received?: NodeJS.ProcessEnv
  run?: CommandRunner
} = {}): Promise<boolean> => {
  const received = input.received ?? process.env
  return (input.platform ?? process.platform) === 'win32' && (
    received.NESSIE_EXECUTOR_SUPERVISOR === 'service' || await runsAsWindowsServiceAccount(input.run ?? runCommand, received)
  )
}

const loggedIn = (agent: CodingAgentName, outcome: { code: number | null; stdout: string }): boolean => {
  if (agent === 'codex') return outcome.code === 0
  try {
    const parsed = JSON.parse(outcome.stdout) as { loggedIn?: unknown }
    if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn
  } catch {
    // An older CLI prints text; its exit code is the answer.
  }
  return outcome.code === 0
}

export const runCodingSelfCheck = async (input: {
  agent: CodingAgentName
  config: CodingAgentConfig
  cwd: string
  env: NodeJS.ProcessEnv
  /** `codingSessions.maxBudgetUsd`, which adds `--max-budget-usd` to what the CLI must offer. */
  maxBudgetUsd?: number
  /** Where what each CLI's `--help` offers is cached; without one it is read every time. */
  helpCacheFile?: string
  platform?: NodeJS.Platform
  /** The host's own environment, where the daemon's supervisor marker arrives. */
  received?: NodeJS.ProcessEnv
  run?: CommandRunner
}): Promise<CodingSelfCheckOutcome> => {
  const run = input.run ?? runCommand
  const platform = input.platform ?? process.platform
  const received = input.received ?? process.env
  if (await runsUnderWindowsService({ platform, received, run })) return { ok: false, reason: 'unsupported_supervisor' }
  const options = { env: input.env, cwd: input.cwd }
  const [program, ...prefix] = input.config.command
  // Read-only probes side by side, so the help read adds no start time; they are judged in order below.
  const versionRead = run(program!, [...prefix, '--version'], options)
  const [git, gh, version, capabilities] = await Promise.all([
    run('git', ['--version'], options),
    run('gh', ['auth', 'status'], options),
    versionRead,
    readAgentCapabilities({
      agent: input.agent, command: input.config.command, cwd: input.cwd, env: input.env, run,
      version: versionRead.then(agentVersionStamp),
      ...(input.helpCacheFile === undefined ? {} : { cacheFile: input.helpCacheFile }),
    }),
  ])
  if (git.code !== 0) return { ok: false, reason: 'git_missing' }
  if (version.code !== 0) return { ok: false, reason: 'agent_missing' }
  const offered = checkAgentCapabilities({
    agent: input.agent, config: input.config, capabilities,
    ...(input.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: input.maxBudgetUsd }),
  })
  if (!offered.ok) return offered
  const login = await run(program!, [...prefix, ...(input.agent === 'claude' ? ['auth', 'status'] : ['login', 'status'])], options)
  if (!loggedIn(input.agent, login)) return { ok: false, reason: 'agent_not_logged_in' }
  // `gh` is optional; a present one that is logged out would make every PR step fail.
  if (!gh.missing && gh.code !== 0) return { ok: false, reason: 'gh_not_authenticated' }
  const firstLine = version.stdout.split(/\r?\n/u)[0]?.trim() ?? ''
  return {
    ok: true,
    ...(VERSION_TEXT.test(firstLine) ? { agentVersion: firstLine } : {}),
    ...(offered.unverified ? { unverified: offered.unverified } : {}),
  }
}
