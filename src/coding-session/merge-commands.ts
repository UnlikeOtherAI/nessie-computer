import { EXECUTOR_CODING_MERGE_COMMANDS, type ExecutorCodingMergeCommand } from '@nessie/executor-protocol'

import type { CodingAgentConfig } from './config.js'

/**
 * Which pull-request commands Claude Code may run without being asked, for
 * the signed `mergeCommands` fact, and whether it may run any command at all
 * unasked, for the signed `unaskedCommands` fact
 * (docs/executor-protocol/host-coding-sessions.md).
 *
 * Read from the reviewed configuration the way Claude Code reads a Bash
 * permission rule, and never more generously: `Bash`, `Bash(*)` and
 * `Bash(:*)` cover every command; `Bash(git push:*)` and `Bash(git *)` cover a
 * command that is that prefix or starts with it and a space; `Bash(gi*)`
 * covers one that starts with the prefix. An exact `Bash(git push)` covers
 * only the bare command, which never pushes a branch, so it does not count,
 * and a pattern with a wildcard anywhere but its end is not understood here,
 * so it does not count either. A `disallowedTools` entry that covers a command
 * takes it back, as it does in Claude Code. `bypassPermissions` runs
 * everything unasked.
 */

const BASH_RULE = /^Bash(?:\((.*)\))?$/u

/** A bare `Bash`, `Bash(*)` or `Bash(:*)`: a rule for every command, not only those with some prefix. */
const coversEveryCommand = (entry: string): boolean => {
  const rule = BASH_RULE.exec(entry.trim())
  if (!rule) return false
  const pattern = rule[1]
  return pattern === undefined || pattern === '*' || pattern === ':*'
}

const covers = (entry: string, command: string): boolean => {
  if (coversEveryCommand(entry)) return true
  const pattern = BASH_RULE.exec(entry.trim())?.[1]
  if (pattern === undefined) return false
  if (!pattern.endsWith('*') || pattern.slice(0, -1).includes('*')) return false
  const wordPrefix = /^(.*?)(?::| )\*$/u.exec(pattern)
  if (wordPrefix) {
    const prefix = wordPrefix[1]!.trimEnd()
    return prefix.length > 0 && (command === prefix || command.startsWith(`${prefix} `))
  }
  const prefix = pattern.slice(0, -1)
  return prefix.length > 0 && command.startsWith(prefix)
}

export const claudeMergeCommands = (claude: CodingAgentConfig | undefined): ExecutorCodingMergeCommand[] => {
  if (!claude) return []
  if (claude.permissionMode === 'bypassPermissions') return [...EXECUTOR_CODING_MERGE_COMMANDS]
  return EXECUTOR_CODING_MERGE_COMMANDS.filter((command) => (
    claude.allowedTools.some((entry) => covers(entry, command))
    && !claude.disallowedTools.some((entry) => covers(entry, command))
  ))
}

/**
 * `any` when Claude Code may run whatever command it likes without asking:
 * under `bypassPermissions`, or when an `allowedTools` entry covers every
 * command and no `disallowedTools` entry takes every command back. A narrower
 * disallowed rule (`Bash(rm:*)`) leaves it `any`, since every other command
 * still runs unasked. `listed` otherwise, and when Claude Code is not offered.
 */
export const claudeUnaskedCommands = (claude: CodingAgentConfig | undefined): 'any' | 'listed' => {
  if (!claude) return 'listed'
  if (claude.permissionMode === 'bypassPermissions') return 'any'
  return claude.allowedTools.some(coversEveryCommand) && !claude.disallowedTools.some(coversEveryCommand)
    ? 'any'
    : 'listed'
}
