import { formatExecutorCommandPattern, parseExecutorCommandPattern } from '@nessie/executor-protocol'

import { localCommandPolicyOf, type LocalCommandPolicy } from './command-policy.js'
import { saveAccess } from './cli-describe.js'
import { acceptOnly, onOff, operands } from './cli-options.js'
import { CliRefusal, CliUsageError, columns, listed, printJson } from './cli-output.js'
import type { CliRun } from './cli-user.js'
import type { ProgramTrust, ProgramTrustKey } from './program-trust.js'
import { loadExecutorState } from './state-store.js'

/**
 * `access programs`: the Programs section of the Access tab. Every change is
 * a whole `LocalCommandPolicy` saved through the writer `configure` uses, and
 * shows the rule before and after, as the window's Apply does.
 */

const BUILTIN_NAMES: Record<ProgramTrustKey, string> = {
  unlikeotherai: 'Apps from UnlikeOtherAI', claudeCode: 'Claude Code', codex: 'Codex', t3Code: 'T3 Code',
}

/** The command line's spelling of each built-in. */
const BUILTIN_WORDS: Record<string, ProgramTrustKey> = {
  unlikeotherai: 'unlikeotherai', 'claude-code': 'claudeCode', codex: 'codex', 't3-code': 't3Code',
}

const noTrust = (): ProgramTrust => ({ unlikeotherai: false, claudeCode: false, codex: false, t3Code: false })

/** The order the window lists the built-ins in. */
const BUILTIN_ORDER: readonly ProgramTrustKey[] = ['unlikeotherai', 'claudeCode', 'codex', 't3Code']

/** "Only these: Apps from UnlikeOtherAI, Claude Code, npm *", "Any program", "No programs" — the window's words. */
export const programRuleSummary = (policy: LocalCommandPolicy): string => {
  if (policy.mode === 'all') {
    return policy.denylist.length ? `Any program except ${listed(policy.denylist)}` : 'Any program'
  }
  const builtins = BUILTIN_ORDER.filter((key) => policy.trusted?.[key]).map((key) => BUILTIN_NAMES[key])
  const allowed = [...builtins, ...policy.allowlist]
  if (allowed.length === 0) return 'No programs'
  return `Only these: ${allowed.join(', ')}${policy.denylist.length ? `; blocked: ${policy.denylist.join(', ')}` : ''}`
}

/** A bare program name means that program with any arguments; a pattern is kept as written. */
const ruleFrom = (value: string): string => {
  const written = /\s/u.test(value.trim()) ? value.trim() : `${value.trim()} *`
  const parsed = parseExecutorCommandPattern(written)
  if (!parsed) throw new CliUsageError(`${value} isn't a program or pattern. Use rules such as git * or npm run *.`, 'access programs')
  return formatExecutorCommandPattern(parsed)
}

const showPolicy = (run: CliRun, label: string, policy: LocalCommandPolicy): void => {
  if (run.options.json) {
    printJson(run.context, policy)
    return
  }
  const builtins = BUILTIN_ORDER.map((key) => [BUILTIN_NAMES[key], policy.trusted?.[key] ? 'on' : 'off'])
  run.context.out([`${label} may start: ${policy.mode === 'all' ? 'Any program' : 'Only these programs'}`,
    `Currently allowed: ${programRuleSummary(policy)}.`, '', 'Built in:', columns(builtins, '  '),
    `Added by you: ${listed(policy.allowlist)}`, `Blocked: ${listed(policy.denylist)}`, '',
    'Programs run as you and can open any file you can.'].join('\n') + '\n')
}

const changed = (policy: LocalCommandPolicy, action: string, words: string[]): LocalCommandPolicy => {
  const [first, second] = words
  if (action === 'mode') {
    if (second !== undefined) throw new CliUsageError('mode takes one word: only-these, any or none.', 'access programs')
    if (first === 'only-these') return { ...policy, mode: 'allowlist' }
    if (first === 'any') return { ...policy, mode: 'all' }
    if (first === 'none') return { ...policy, mode: 'allowlist', allowlist: [], trusted: noTrust() }
    throw new CliUsageError('Use mode only-these, any or none.', 'access programs')
  }
  if (action === 'default') {
    const key = first === undefined ? undefined : BUILTIN_WORDS[first]
    if (!key) throw new CliUsageError('Use default unlikeotherai, claude-code, codex or t3-code, then on or off.', 'access programs')
    return { ...policy, trusted: { ...(policy.trusted ?? noTrust()), [key]: onOff(second, 'access programs default <program>') } }
  }
  if (first === undefined || second !== undefined) {
    throw new CliUsageError(`Give one program or pattern, in quotes when it has spaces: access programs ${action} "git *".`,
      'access programs')
  }
  const rule = ruleFrom(first)
  if (action === 'allow') {
    if (policy.allowlist.includes(rule)) throw new CliRefusal('PROGRAM_LISTED', `${rule} is already allowed.`)
    return { ...policy, allowlist: [...policy.allowlist, rule].sort() }
  }
  if (action === 'block') {
    if (policy.denylist.includes(rule)) throw new CliRefusal('PROGRAM_LISTED', `${rule} is already blocked.`)
    return { ...policy, denylist: [...policy.denylist, rule].sort() }
  }
  if (action === 'remove') {
    if (!policy.allowlist.includes(rule) && !policy.denylist.includes(rule)) {
      throw new CliRefusal('PROGRAM_NOT_FOUND', `${rule} isn't in the list.`)
    }
    return { ...policy, allowlist: policy.allowlist.filter((entry) => entry !== rule),
      denylist: policy.denylist.filter((entry) => entry !== rule) }
  }
  throw new CliUsageError(`access programs has no "${action}". Use show, allow, block, remove, mode or default.`, 'access programs')
}

export const runAccessPrograms = async (run: CliRun): Promise<void> => {
  acceptOnly(run.options, 'access programs')
  const [action = 'show', ...words] = operands(run.options, 2, 3, 'access programs')
  const team = await run.team()
  const before = localCommandPolicyOf(await loadExecutorState(team.stateDir))
  if (action === 'show') {
    if (words.length) throw new CliUsageError('access programs show takes nothing after it.', 'access programs')
    showPolicy(run, team.label, before)
    return
  }
  const after = changed(before, action, words)
  const saved = localCommandPolicyOf(await saveAccess(team.stateDir, { commandPolicy: after }))
  if (run.options.json) {
    printJson(run.context, saved)
    return
  }
  run.context.out(`Was: ${programRuleSummary(before)}\nNow: ${programRuleSummary(saved)}\n`
    + (saved.mode === 'all' && action === 'allow' ? 'Not used while any program is allowed.\n' : '')
    + (programRuleSummary(saved) === 'No programs' ? `No programs means agents in ${team.label} start nothing on this computer.\n` : ''))
}
