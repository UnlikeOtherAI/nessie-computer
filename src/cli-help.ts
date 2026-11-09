import { CliUsageError } from './cli-output.js'
import { canonicalWords, HELP_ENTRIES, HELP_GROUPS, type HelpEntry } from './cli-help-entries.js'

/**
 * `nessie-computer help`, `help <command>`, `<command> --help` and
 * `help plumbing`. The words are in `cli-help-entries.ts`.
 */

const OVERVIEW_INTRO = [
  'Nessie Computer lets agents in your Nessie team use this computer.',
  'The command line does everything the window does, with the same words.',
  '',
  'Usage: nessie-computer <command> [options]',
]

const COMMON_OPTIONS = [
  'Options every command takes:',
  '  --team <team>  The team: its name as shown ("Sales · Acme"), a unique part of it, or its id.',
  '                 Optional when only one team is connected.',
  '  --json         Machine-readable output (one JSON document on standard output).',
  '  --help         Help for the command, with examples.',
  '',
  'Exit codes: 0 worked · 1 refused or failed · 2 typed wrong · 3 waiting timed out.',
]

const entryFor = (command: string): HelpEntry | undefined => HELP_ENTRIES.find((entry) => entry.command === command)

const renderEntry = (entry: HelpEntry): string => [
  entry.summary, '', 'Usage:', ...entry.usage.map((line) => `  ${line}`),
  ...(entry.notes?.length ? ['', ...entry.notes] : []),
  '', 'Examples:', ...entry.examples.map((line) => `  ${line}`),
  '', 'Every command also takes --team, --json and --help. See nessie-computer help.',
].join('\n')

const renderOverview = (): string => {
  const width = Math.max(...HELP_ENTRIES.map((entry) => entry.command.length))
  const groups = HELP_GROUPS.flatMap((group) => ['', `${group.title}:`, ...group.commands.map((command) => (
    `  ${command.padEnd(width)}  ${entryFor(command)!.summary}`))])
  return [...OVERVIEW_INTRO, ...groups, '', ...COMMON_OPTIONS, '',
    'Run nessie-computer help <command> for its options and examples.',
    'The apps and services use lower-level commands: nessie-computer help plumbing.'].join('\n')
}

/** A group such as `access` lists its commands. */
const renderGroup = (prefix: string): string | undefined => {
  const members = HELP_ENTRIES.filter((entry) => entry.command.startsWith(`${prefix} `))
  if (members.length === 0) return undefined
  return [`nessie-computer ${prefix} commands:`, '',
    ...members.flatMap((entry) => [`${entry.command} — ${entry.summary}`, ...entry.usage.map((line) => `  ${line}`), '']),
    `Run nessie-computer help ${members[0]!.command} for examples.`].join('\n')
}

export const PLUMBING_HELP = [
  'Lower-level commands the apps and services use. They take a team\'s state folder (--state-dir)',
  'and JSON on standard input or output. Prefer the other commands in your own scripts.',
  '',
  'One team:',
  '  nessie-computer describe --state-dir <dir>',
  '  nessie-computer configure --configuration-input-stdin --state-dir <dir>',
  '  nessie-computer configure --state-dir <dir> --operations <list> [--workspace <path>|--folder <name>=<path> ...]',
  '    [--tools <program,...>|--clear-tools] [--mcp-server <name>=<command> ...|--clear-mcp-servers]',
  '  nessie-computer pause|resume --state-dir <dir> [--json]',
  '  nessie-computer program-requests --state-dir <dir> [--json]',
  '  nessie-computer program-request answer --state-dir <dir> --id <request-id> --answer once|always|deny [--json]',
  '  nessie-computer sessions --state-dir <dir> [--json]',
  '  nessie-computer session stop --state-dir <dir> --id <session-id> [--json]',
  '  nessie-computer sync (--executor <id>|--state-dir <dir>) [on|off|pause|resume|status|verify|trash|resolve|',
  '    confirm-held|restore-held] [--root <folder>] [--json] [--accept-existing-files]',
  '    [--conflict <id> --resolution keep_mine|keep_nessie|dismiss] [--batch <id>]',
  '  nessie-computer sync (--executor <id>|--state-dir <dir>) --input-stdin',
  '  nessie-computer local-inference endpoint configure|status|remove --state-dir <dir> [--config-stdin]',
  '  nessie-computer local-inference connections status|--operation-stdin --state-dir <dir>',
  '  nessie-computer local-inference engines list|--operation-stdin --state-dir <dir>',
  '  nessie-computer personal-chatgpt-local --operation-stdin --state-dir <dir>',
  '  nessie-computer unpair (--executor <id>|--state-dir <dir>) [--json]',
  '',
  'Every team at once:',
  '  nessie-computer team-names --state-dir <dir> [--state-dir <dir> ...] [--json]',
  '',
  'Adding this computer (the app\'s Add this computer dialog):',
  '  nessie-computer pairing-start --api <nessie|https://your-nessie.example> [--cli] [--state-dir <dir>] [--json]',
  '  nessie-computer pairing-status|pairing-cancel --state-dir <dir> [--json]',
  '  nessie-computer login --api <nessie|https://your-nessie.example> [--workspace <folder>]',
  '  nessie-computer pair --api <address> --enrollment <id> --pair-input-stdin --state-dir <dir>',
  '',
  'Running a team:',
  '  nessie-computer serve [--parent-liveness-stdin] --state-dir <dir>',
  '  nessie-computer connect|heartbeat --state-dir <dir>',
  '  nessie-computer daemon --executor <id>',
  '  nessie-computer permissions --executor <id> [--existing-sessions on|off] [--allow-all|--allow "git *,pnpm *"]',
  '    [--deny "git push *"|--clear-deny]',
  '  nessie-computer teams --state-root <dir> [--json]',
  '',
  'Services (Linux systemd, macOS launchd):',
  '  nessie-computer enable <executor-id> [--state-dir <dir>] [--yes]',
  '  nessie-computer disable <executor-id>',
  '  nessie-computer autorestart <executor-id> [on|off]',
  '  nessie-computer status <executor-id> [--state-root <dir>]',
  '  nessie-computer updates [status|check|install|remind|automatic on|off|channel stable|preview] [--json]',
  '',
  'The agents\' browser and sandbox:',
  '  nessie-computer configure-browser --state-dir <dir> --allowed-origins <https://origin,...>',
  '    --guest-initrd-builder <file> --kernel <file> --vm-helper <file> --runtime-bundle <directory>',
  '  nessie-computer configure-codex --state-dir <dir> --auth-profile <auth.json>',
  '    --guest-initrd-builder <file> --kernel <file> --vm-helper <file> --runtime-bundle <directory>',
  '',
  'Started by Nessie Computer itself:',
  '  serve-ollama-search-mcp, serve-coding-session-mcp, serve-session-secrets, coding-session-host,',
  '  serve-direct-local-inference, serve-existing-claude-channel, deeptest-source, deeptest-execution,',
  '  deeptest-inference, publish-deeptest-*-grant, revoke-deeptest-*-grant, native-browser-cookie-import',
  '',
  'nessie-executor is the same command under its older name.',
].join('\n')

/** The help text for `help <words…>`; a usage error for a command that doesn't exist. */
export const helpText = (asked: readonly string[]): string => {
  const words = canonicalWords(asked)
  if (words.length === 0) return renderOverview()
  const command = words.join(' ')
  if (command === 'plumbing') return PLUMBING_HELP
  const entry = entryFor(command) ?? entryFor(words.slice(0, 2).join(' ')) ?? entryFor(words[0]!)
  if (entry) return renderEntry(entry)
  const group = renderGroup(words[0]!)
  if (group) return group
  throw new CliUsageError(`nessie-computer has no command "${command}".`)
}
