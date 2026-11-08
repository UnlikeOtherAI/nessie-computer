import type { LocalCliEngine } from '@nessie/executor-protocol'

import { buildAgentEnvironment, runCommand, type CommandRunner } from './coding-session/agent-env.js'
import { findProviderProgram, type ProviderProgram } from './existing-session/programs.js'
import { CodexRpc } from './provider-process/codex-rpc.js'
import { localCliAccountDirectory, localCliAccountEnvironment, type LocalCliAccount } from './local-cli-engine-accounts.js'

/**
 * Whether Claude Code or Codex is installed and signed in, and to which
 * account — through the CLIs' own read-only status probes (`claude auth
 * status --json`, Codex's `account/read`). Nothing here reads, copies or
 * refreshes a credential, and nothing starts a model turn.
 */
export type LocalCliDetection = {
  engine: LocalCliEngine
  profileId: string | null
  installed: boolean
  signedIn: boolean
  account?: string
  program?: ProviderProgram
  env: NodeJS.ProcessEnv
}

export type LocalCliProbes = {
  findProgram: (engine: LocalCliEngine, env: NodeJS.ProcessEnv) => Promise<ProviderProgram | undefined>
  claudeStatus: (program: string, env: NodeJS.ProcessEnv) => Promise<{ signedIn: boolean; account?: string }>
  codexStatus: (program: string, env: NodeJS.ProcessEnv) => Promise<{ signedIn: boolean; account?: string }>
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const email = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= 254 ? value.trim() : undefined

export const claudeAuthStatus = async (
  program: string, env: NodeJS.ProcessEnv, run: CommandRunner = runCommand,
): Promise<{ signedIn: boolean; account?: string }> => {
  const result = await run(program, ['auth', 'status', '--json'], { env, timeoutMs: 10_000, maxBytes: 64 * 1024 })
  let status: unknown
  try { status = JSON.parse(result.stdout) as unknown } catch { return { signedIn: false } }
  if (!record(status) || status.loggedIn !== true) return { signedIn: false }
  const account = email(status.email)
  return { signedIn: true, ...(account ? { account } : {}) }
}

export const codexAccountStatus = async (
  program: string, env: NodeJS.ProcessEnv,
): Promise<{ signedIn: boolean; account?: string }> => {
  const rpc = new CodexRpc(program, env)
  try {
    const value = await rpc.call('account/read', {})
    if (!record(value) || !record(value.account)) return { signedIn: false }
    const account = email(value.account.email)
    return { signedIn: true, ...(account ? { account } : {}) }
  } catch { return { signedIn: false } } finally { rpc.close() }
}

export const defaultLocalCliProbes: LocalCliProbes = {
  findProgram: (engine, env) => findProviderProgram(engine === 'claude-code' ? 'claude' : 'codex', env),
  claudeStatus: (program, env) => claudeAuthStatus(program, env),
  codexStatus: codexAccountStatus,
}

/** The owner's own environment, as the coding-session and quota readers build it. */
export const ownerCliEnvironment = (): Promise<NodeJS.ProcessEnv> =>
  buildAgentEnvironment({ config: { inheritUserSession: true, pass: [], set: {} } })

/** One row per engine's default account, then one per added account. */
export const detectLocalCliEngines = async (input: {
  accounts: LocalCliAccount[]; accountsRoot: string; env?: NodeJS.ProcessEnv; probes?: LocalCliProbes
  /** Detect only this engine connection. */
  only?: { engine: LocalCliEngine; profileId: string | null }
}): Promise<LocalCliDetection[]> => {
  const probes = input.probes ?? defaultLocalCliProbes
  const base = input.env ?? await ownerCliEnvironment()
  const targets: Array<{ engine: LocalCliEngine; profileId: string | null }> = input.only ? [input.only] : [
    { engine: 'claude-code', profileId: null }, { engine: 'codex', profileId: null },
    ...input.accounts.map((account) => ({ engine: account.engine, profileId: account.id })),
  ]
  const programs = new Map<LocalCliEngine, Promise<ProviderProgram | undefined>>()
  const programFor = (engine: LocalCliEngine) => {
    let found = programs.get(engine)
    if (!found) { found = probes.findProgram(engine, base).catch(() => undefined); programs.set(engine, found) }
    return found
  }
  return Promise.all(targets.map(async ({ engine, profileId }) => {
    const env = localCliAccountEnvironment(engine, base,
      profileId === null ? null : localCliAccountDirectory(input.accountsRoot, profileId))
    const program = await programFor(engine)
    if (!program) return { engine, profileId, installed: false, signedIn: false, env }
    const status = await (engine === 'claude-code' ? probes.claudeStatus : probes.codexStatus)(program.path, env)
      .catch(() => ({ signedIn: false }))
    return { engine, profileId, installed: true, ...status, program, env }
  }))
}
