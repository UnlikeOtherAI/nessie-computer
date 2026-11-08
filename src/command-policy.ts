import {
  EXECUTOR_COMMAND_ALLOWLIST_MAXIMUM,
  ExecutorCommandAllowlistSchema,
  ExecutorCommandRunArgumentsSchema,
  executorCommandAllowlistPermits,
  formatExecutorCommandPattern,
  parseExecutorCommandPattern,
} from '@nessie/executor-protocol'

import { absoluteDirectory, resolveProgramPath } from './coding-session/program-path.js'
import { allProgramTrust, parseProgramTrust, trustedProgramNamed, type ProgramTrust } from './program-trust.js'
import { verifiedUnlikeOtherAiProgram, type PublisherVerification } from './program-trust-signature.js'

/**
 * Machine-owned rules. These never enter a descriptor or a server response.
 * They decide which sandboxed commands run and which programs a host terminal
 * session may start.
 *
 * `trusted` holds the built-in Programs defaults (`program-trust.ts`). Absent
 * means none, which is every connection paired before they existed; a new
 * pairing writes all four on. An allowlist with no patterns and nothing
 * trusted is the enforced "No programs" state, not a misconfiguration.
 */
export type LocalCommandPolicy = {
  mode: 'all' | 'allowlist'
  allowlist: string[]
  denylist: string[]
  trusted?: ProgramTrust
}

/** What a connection with no saved rules reads as: today's allow-all, nothing built in. */
export const newLocalCommandPolicy = (): LocalCommandPolicy => ({ mode: 'all', allowlist: [], denylist: [] })

/**
 * What a new pairing writes (contract §4.3): only the built-in programs —
 * apps signed by UnlikeOtherAI, Claude Code, Codex and T3 Code — and the
 * owner's approval for anything else.
 */
export const pairedLocalCommandPolicy = (): LocalCommandPolicy => ({
  mode: 'allowlist', allowlist: [], denylist: [], trusted: allProgramTrust(),
})

const POLICY_KEYS = 'allowlist,denylist,mode'

export const parseLocalCommandPolicy = (value: unknown): LocalCommandPolicy => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local command policy.')
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).filter((key) => key !== 'trusted').sort().join(',')
  if (keys !== POLICY_KEYS || !['all', 'allowlist'].includes(String(input.mode))) {
    throw new Error('Invalid local command policy.')
  }
  const rules = (entries: unknown): string[] => {
    const parsed = ExecutorCommandAllowlistSchema.safeParse(entries)
    if (!parsed.success) throw new Error('Use command rules such as "git *" or "npm run *", one per line.')
    const normalized = parsed.data.map((entry) => formatExecutorCommandPattern(parseExecutorCommandPattern(entry)!))
    if (new Set(normalized).size !== normalized.length) throw new Error('List each command rule once.')
    return normalized.sort()
  }
  return {
    mode: input.mode as LocalCommandPolicy['mode'], allowlist: rules(input.allowlist), denylist: rules(input.denylist),
    ...(input.trusted === undefined ? {} : { trusted: parseProgramTrust(input.trusted) }),
  }
}

type CommandPolicyState = { commandPolicy?: LocalCommandPolicy; descriptor: { commandAllowlist?: string[] } }

/**
 * The saved rules, or — for a connection that has none — allow-all, which is
 * what every connection paired before `pairedLocalCommandPolicy` read as. One
 * paired before local rules existed keeps an allowlist only when it actually
 * names programs: that list was someone's restriction, while an empty one was
 * never a choice.
 */
export const localCommandPolicyOf = (state: CommandPolicyState): LocalCommandPolicy => {
  if (state.commandPolicy) return parseLocalCommandPolicy(state.commandPolicy)
  const legacy = state.descriptor.commandAllowlist ?? []
  return legacy.length ? { mode: 'allowlist', allowlist: [...legacy], denylist: [] } : newLocalCommandPolicy()
}

/**
 * Whether `command.run` may start `program` in the guest. The guest is a Linux
 * VM, so the trusted names count here as they would for an owner's `claude *`
 * rule, while "Apps from UnlikeOtherAI" admits nothing: no signature on a
 * guest executable can be verified from the host.
 */
export const localCommandPolicyPermits = (state: CommandPolicyState, program: string, args: string[]): boolean => {
  if (!ExecutorCommandRunArgumentsSchema.safeParse({ program, args }).success) return false
  const policy = localCommandPolicyOf(state)
  if (executorCommandAllowlistPermits(policy.denylist, program, args)) return false
  return policy.mode === 'all' || executorCommandAllowlistPermits(policy.allowlist, program, args)
    || trustedProgramNamed(policy.trusted, program)
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
 * executable of that name somewhere and have it run. The trusted built-in
 * names (`claude`, `codex`, `t3`) are read exactly like an owner's rule for
 * that name; "Apps from UnlikeOtherAI" needs a signature, which only
 * {@link localTerminalCommandDecision} checks.
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
  if (terminalRulesMatch(policy.allowlist, name, args, platform)) return undefined
  return trustedProgramNamed(policy.trusted, name) ? undefined : 'not_allowlisted'
}

export type TerminalCommandDecision =
  | { allowed: true; argv: string[] }
  | { allowed: false; refusal: TerminalCommandRefusal }

export type TerminalCommandDecisionOptions = PublisherVerification & {
  /** The environment whose PATH a bare name is found on; the caller's own by default. */
  env?: NodeJS.ProcessEnv
}

/**
 * The whole launch decision for a host terminal session: the name rules of
 * {@link localTerminalCommandRefusal}, then — for a program they do not
 * admit, when "Apps from UnlikeOtherAI" is on — its verified signature. A
 * bare name is resolved through the absolute entries of PATH first. A program
 * admitted by its signature starts from the exact file that was verified, so
 * `argv[0]` comes back as that absolute path; every other admitted launch
 * comes back unchanged. A denial is never re-opened by a signature.
 */
export const localTerminalCommandDecision = async (
  policy: LocalCommandPolicy, argv: readonly string[], options: TerminalCommandDecisionOptions = {},
): Promise<TerminalCommandDecision> => {
  const platform = options.platform ?? process.platform
  const refusal = localTerminalCommandRefusal(policy, argv, platform)
  if (!refusal) return { allowed: true, argv: [...argv] }
  if ((refusal !== 'not_allowlisted' && refusal !== 'path_needs_allow_all') || !policy.trusted?.unlikeotherai) {
    return { allowed: false, refusal }
  }
  const [program, ...args] = argv as [string, ...string[]]
  const located = absoluteDirectory(program, platform)
    ? program
    : await resolveProgramPath(program, options.env ?? process.env, platform)
  const verified = located === undefined ? undefined : await verifiedUnlikeOtherAiProgram(located, options)
  return verified ? { allowed: true, argv: [verified, ...args] } : { allowed: false, refusal }
}

/**
 * The permitted commands, normalised and in one canonical order so that
 * re-stating the same policy — or typing two spaces — is not a new revision
 * for a person to review. Unparseable entries are refused rather than quietly
 * dropped: a list that does not say what its author wrote is worse than none.
 */
export const configuredCommandAllowlist = (requested: readonly string[]): string[] => {
  const parsed = ExecutorCommandAllowlistSchema.safeParse([...requested])
  if (!parsed.success) {
    throw new Error(
      'A permitted command is a program the guest resolves through its fixed PATH, '
      + 'optionally followed by arguments and a trailing "*" — for example "git *" or '
      + `"npm run *". Paths, shells and a leading "*" are refused, at most ${
        EXECUTOR_COMMAND_ALLOWLIST_MAXIMUM
      } entries.`,
    )
  }
  const normalised = parsed.data.map((entry) => {
    const pattern = parseExecutorCommandPattern(entry)
    // The schema just proved every entry parses; this keeps the compiler honest
    // without inventing a second refusal for a state that cannot happen.
    return pattern === undefined ? entry : formatExecutorCommandPattern(pattern)
  })
  if (new Set(normalised).size !== normalised.length) {
    throw new Error('Each permitted command is listed once.')
  }
  return normalised.sort()
}
