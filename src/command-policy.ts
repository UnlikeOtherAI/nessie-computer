import {
  ExecutorCommandAllowlistSchema,
  ExecutorCommandRunArgumentsSchema,
  executorCommandAllowlistPermits,
  formatExecutorCommandPattern,
  parseExecutorCommandPattern,
} from '@nessie/executor-protocol'

import { absoluteDirectory } from './coding-session/program-path.js'

/**
 * Machine-owned rules. These never enter a descriptor or a server response.
 * They decide which sandboxed commands run and which programs a host terminal
 * session may start.
 */
export type LocalCommandPolicy = {
  mode: 'all' | 'allowlist'
  allowlist: string[]
  denylist: string[]
}

export const newLocalCommandPolicy = (): LocalCommandPolicy => ({ mode: 'all', allowlist: [], denylist: [] })

export const parseLocalCommandPolicy = (value: unknown): LocalCommandPolicy => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local command policy.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).sort().join(',') !== 'allowlist,denylist,mode'
    || !['all', 'allowlist'].includes(String(input.mode))) throw new Error('Invalid local command policy.')
  const rules = (entries: unknown): string[] => {
    const parsed = ExecutorCommandAllowlistSchema.safeParse(entries)
    if (!parsed.success) throw new Error('Use command rules such as "git *" or "npm run *", one per line.')
    const normalized = parsed.data.map((entry) => formatExecutorCommandPattern(parseExecutorCommandPattern(entry)!))
    if (new Set(normalized).size !== normalized.length) throw new Error('List each command rule once.')
    return normalized.sort()
  }
  return { mode: input.mode as LocalCommandPolicy['mode'], allowlist: rules(input.allowlist), denylist: rules(input.denylist) }
}

type CommandPolicyState = { commandPolicy?: LocalCommandPolicy; descriptor: { commandAllowlist?: string[] } }

/**
 * Allow-all is the default for every team. A connection paired before local
 * rules existed keeps an allowlist only when it actually names programs: that
 * list was someone's restriction, while an empty one was never a choice.
 */
export const localCommandPolicyOf = (state: CommandPolicyState): LocalCommandPolicy => {
  if (state.commandPolicy) return parseLocalCommandPolicy(state.commandPolicy)
  const legacy = state.descriptor.commandAllowlist ?? []
  return legacy.length ? { mode: 'allowlist', allowlist: [...legacy], denylist: [] } : newLocalCommandPolicy()
}

export const localCommandPolicyPermits = (state: CommandPolicyState, program: string, args: string[]): boolean => {
  if (!ExecutorCommandRunArgumentsSchema.safeParse({ program, args }).success) return false
  const policy = localCommandPolicyOf(state)
  if (executorCommandAllowlistPermits(policy.denylist, program, args)) return false
  return policy.mode === 'all' || executorCommandAllowlistPermits(policy.allowlist, program, args)
}

/** Why a host terminal launch was refused, for the agent to act on. */
export type TerminalCommandRefusal = 'denied' | 'not_allowlisted' | 'path_needs_allow_all' | 'invalid_program'

/** macOS and Windows find `Git` as readily as `git`, so a rule must too. */
const foldsCase = (platform: NodeJS.Platform): boolean => platform === 'win32' || platform === 'darwin'

/** The name a rule compares with: the file name, on Windows without its `.exe`/`.com`. */
const terminalCommandName = (program: string, platform: NodeJS.Platform): string => {
  const name = program.split(platform === 'win32' ? /[\\/]/u : /\//u).at(-1) ?? ''
  const bare = platform === 'win32' ? name.replace(/\.(?:exe|com)$/iu, '') : name
  return foldsCase(platform) ? bare.toLowerCase() : bare
}

/** A rule's program read the same way, so `Git.exe push *` and `git push *` are one rule. */
const terminalRulesMatch = (
  rules: readonly string[], name: string, args: readonly string[], platform: NodeJS.Platform,
): boolean => executorCommandAllowlistPermits(rules.map((rule) => {
  const pattern = parseExecutorCommandPattern(rule)
  if (!pattern) return rule
  return formatExecutorCommandPattern({ ...pattern, program: terminalCommandName(pattern.program, platform) })
}), name, args)

/**
 * Whether a host terminal session may start `argv` (a program, then its
 * arguments) under this computer's command rules. Denials always win, matched
 * on the program's name however it is spelled. **Allow all commands** runs any
 * program, a shell or an absolute path included. **Only allowlisted commands**
 * takes a bare name, which the session resolves through the absolute entries
 * of the person's PATH: an absolute path would let a permitted tool leave an
 * executable of that name somewhere and have it run.
 *
 * These are launch rules. What a started program — a shell, Claude, Codex —
 * then runs with the person's account is its own business, exactly as when the
 * person starts it themselves.
 */
export const localTerminalCommandRefusal = (
  policy: LocalCommandPolicy, argv: readonly string[], platform: NodeJS.Platform = process.platform,
): TerminalCommandRefusal | undefined => {
  const [program, ...args] = argv
  if (!program || program.includes('\0')) return 'invalid_program'
  const absolute = absoluteDirectory(program, platform)
  if (!absolute && /[\\/]/u.test(program)) return 'invalid_program'
  const name = terminalCommandName(program, platform)
  if (!name) return 'invalid_program'
  if (terminalRulesMatch(policy.denylist, name, args, platform)) return 'denied'
  if (policy.mode === 'all') return undefined
  if (absolute) return 'path_needs_allow_all'
  return terminalRulesMatch(policy.allowlist, name, args, platform) ? undefined : 'not_allowlisted'
}
