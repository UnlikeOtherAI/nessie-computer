/**
 * The help for every `nessie-computer` command, in the words of the window
 * (contract §2). Each usage line is exactly a line of the Command reference
 * (`docs/wiki/Command-reference.md`); `test/cli-help.test.ts` fails when the
 * two differ or a command has no entry.
 */
export type HelpEntry = {
  /** The command words, e.g. `access programs`. */
  command: string
  summary: string
  usage: string[]
  notes?: string[]
  examples: string[]
}

export const HELP_GROUPS: Array<{ title: string; commands: string[] }> = [
  { title: 'Overview', commands: ['status', 'teams', 'who'] },
  { title: 'Connecting', commands: ['connect', 'disconnect'] },
  { title: 'Pausing', commands: ['pause', 'resume'] },
  { title: 'Access', commands: ['access show', 'access folders', 'access programs', 'access websites',
    'access local-apps', 'access coding-assistants'] },
  { title: 'Program requests', commands: ['requests'] },
  { title: 'Now working', commands: ['sessions'] },
  { title: 'Documents', commands: ['documents'] },
  { title: 'AI', commands: ['ai plans', 'ai servers'] },
  { title: 'Settings', commands: ['settings'] },
  { title: 'Help', commands: ['help'] },
]

export const HELP_ENTRIES: HelpEntry[] = [
  {
    command: 'status', summary: 'What Nessie Computer and each team are doing, and anything that needs you.',
    usage: ['nessie-computer status [--team <team>] [--json]'],
    notes: ['Each team shows Working, Paused, Needs you or Not connected.'],
    examples: ['nessie-computer status', 'nessie-computer status --team Sales --json'],
  },
  {
    command: 'teams', summary: 'List connected teams: label, status, server and id.',
    usage: ['nessie-computer teams [--json]'],
    examples: ['nessie-computer teams', 'nessie-computer teams --json'],
  },
  {
    command: 'who', summary: 'Who can send work to this computer for a team: agents, people and projects.',
    usage: ['nessie-computer who [--team <team>] [--json]'],
    notes: ['Read from Nessie each time; nothing is stored.'],
    examples: ['nessie-computer who --team "Sales · Acme"'],
  },
  {
    command: 'connect', summary: 'Get a pairing code for a new team and wait until it\'s entered in Nessie.',
    usage: ['nessie-computer connect [--server <https://address>] [--no-wait] [--json]'],
    notes: [
      '--server  Your organisation\'s own Nessie (default https://api.nessie.works).',
      '--no-wait  Print the code and return; status shows when it\'s done.',
      'On Linux, a connected team starts at boot and keeps running after you log out.',
      'On Windows, connect a team in the Nessie Computer app.',
    ],
    examples: ['nessie-computer connect', 'nessie-computer connect --server https://nessie.example.com'],
  },
  {
    command: 'disconnect', summary: 'End a team\'s connection to this computer and delete its settings here.',
    usage: ['nessie-computer disconnect --team <team> [--yes]'],
    notes: ['Your own files stay as they are. Without --yes it asks first.'],
    examples: ['nessie-computer disconnect --team "Research · Acme"'],
  },
  {
    command: 'pause', summary: 'Stop agents starting anything new; work already running finishes.',
    usage: ['nessie-computer pause [--team <team>]'],
    notes: ['Without --team it pauses every team. It lasts until you resume, across restarts and updates.'],
    examples: ['nessie-computer pause', 'nessie-computer pause --team "Sales · Acme"'],
  },
  {
    command: 'resume', summary: 'Let agents use this computer again after a pause.',
    usage: ['nessie-computer resume [--team <team>]'],
    notes: ['Without --team it resumes every team.'],
    examples: ['nessie-computer resume'],
  },
  {
    command: 'access show', summary: 'Everything a team can use.',
    usage: ['nessie-computer access show [--team <team>] [--json]'],
    examples: ['nessie-computer access show --team Sales'],
  },
  {
    command: 'access folders', summary: 'The folders agents in a team can read.',
    usage: [
      'nessie-computer access folders [list] [--team <team>]',
      'nessie-computer access folders add <path> [--name <name>] [--team <team>]',
      'nessie-computer access folders remove <name|path> [--team <team>]',
    ],
    notes: ['--name sets the name agents use (default: from the folder\'s name). Keep at least one folder.'],
    examples: ['nessie-computer access folders add /srv/projects --team Sales'],
  },
  {
    command: 'access programs', summary: 'The programs agents in a team may start.',
    usage: [
      'nessie-computer access programs [show] [--team <team>]',
      'nessie-computer access programs allow <program|pattern> [--team <team>]',
      'nessie-computer access programs block <program|pattern> [--team <team>]',
      'nessie-computer access programs remove <program|pattern> [--team <team>]',
      'nessie-computer access programs mode only-these|any|none [--team <team>]',
      'nessie-computer access programs default <unlikeotherai|claude-code|codex|t3-code> on|off [--team <team>]',
    ],
    notes: [
      'A bare program name (npm) means the program with any arguments (npm *).',
      'Patterns: git status exactly; git * with anything after it. Blocked wins.',
      'mode none switches every default off and clears the list.',
      'Programs run as you and can open any file you can.',
      'Every change shows what changed, then applies it at once.',
    ],
    examples: ['nessie-computer access programs allow git --team Sales',
      'nessie-computer access programs block "git push *" --team Sales'],
  },
  {
    command: 'access websites', summary: 'The websites agents in a team may open in the agent browser.',
    usage: [
      'nessie-computer access websites [list] [--team <team>]',
      'nessie-computer access websites add <https://site> [--team <team>]',
      'nessie-computer access websites remove <https://site> [--team <team>]',
    ],
    examples: ['nessie-computer access websites add https://docs.example.com --team Sales'],
  },
  {
    command: 'access local-apps', summary: 'Apps on this computer agents can talk to (MCP servers).',
    usage: [
      'nessie-computer access local-apps [list] [--team <team>]',
      'nessie-computer access local-apps on|off <name> [--team <team>]',
      'nessie-computer access local-apps all on|off [--team <team>]',
      'nessie-computer access local-apps remove <name> [--team <team>]',
    ],
    notes: [
      'all on uses every installed local app, including new ones (the default).',
      'all off switches off every local app found now; apps installed later start switched on.',
      'remove takes away a local app you added yourself.',
    ],
    examples: ['nessie-computer access local-apps off kelpie --team Sales'],
  },
  {
    command: 'access coding-assistants', summary: 'Let agents read and message your Claude Code and Codex conversations.',
    usage: [
      'nessie-computer access coding-assistants [show] [--team <team>]',
      'nessie-computer access coding-assistants conversations on|off [--team <team>]',
      'nessie-computer access coding-assistants claude-setup [--team <team>]',
    ],
    notes: ['claude-setup prints the steps to let Claude Code receive messages from Nessie.'],
    examples: ['nessie-computer access coding-assistants conversations on --team Sales'],
  },
  {
    command: 'requests', summary: 'Answer an agent that asked to run a program that isn\'t allowed.',
    usage: [
      'nessie-computer requests [list] [--team <team>] [--json]',
      'nessie-computer requests allow-once <id>',
      'nessie-computer requests always <id>',
      'nessie-computer requests deny <id>',
      'nessie-computer requests watch [--team <team>]',
    ],
    notes: [
      'always adds the program to the team\'s programs. watch prints new requests as they arrive.',
      'An id may be shortened to its first characters while it stays unique.',
      'A request waits up to 15 minutes, then is refused. Only the agent\'s asking command waits.',
    ],
    examples: ['nessie-computer requests list', 'nessie-computer requests allow-once 7f3a9c21'],
  },
  {
    command: 'sessions', summary: 'What agents are doing on this computer now, and Stop for one agent\'s work.',
    usage: [
      'nessie-computer sessions [list] [--team <team>] [--json]',
      'nessie-computer sessions stop <id> [--team <team>]',
    ],
    notes: [
      'Each session is one agent\'s work for a team, with its commands: running, waiting to start, or waiting for you.',
      'stop ends everything that session is doing here and tells Nessie. Other sessions keep working.',
      'An id may be shortened to its first characters while it stays unique.',
    ],
    examples: ['nessie-computer sessions', 'nessie-computer sessions stop 0b0c3a40'],
  },
  {
    command: 'documents', summary: 'Keep a copy of a team\'s documents on this computer.',
    usage: [
      'nessie-computer documents [status] [--team <team>]',
      'nessie-computer documents on [--folder <path>] [--add-existing-files] [--team <team>]',
      'nessie-computer documents off [--team <team>]',
      'nessie-computer documents folder <path> [--team <team>]',
      'nessie-computer documents pause|resume [--team <team>]',
      'nessie-computer documents conflicts [--team <team>]',
      'nessie-computer documents resolve <id> mine|nessie|both [--team <team>]',
      'nessie-computer documents deleted [--team <team>]',
      'nessie-computer documents restore <id> [--team <team>]',
      'nessie-computer documents held [--team <team>]',
      'nessie-computer documents held restore|delete [--team <team>]',
    ],
    notes: ['on prints the Nessie page to open if Nessie asks you to allow it.',
      'held lists large deletions waiting for you.'],
    examples: ['nessie-computer documents on --team "Sales · Acme" --folder ~/Documents/Nessie',
      'nessie-computer documents conflicts --team "Sales · Acme"'],
  },
  {
    command: 'ai plans', summary: 'ChatGPT plans that fund your own agents.',
    usage: [
      'nessie-computer ai plans [list] [--team <team>]',
      'nessie-computer ai plans add [<name>] [--yes] [--team <team>]',
      'nessie-computer ai plans rename <plan> <new name> [--team <team>]',
      'nessie-computer ai plans sign-in <plan> [--yes] [--team <team>]',
      'nessie-computer ai plans background <plan> on|off [--team <team>]',
      'nessie-computer ai plans disconnect <plan> [--team <team>]',
    ],
    notes: [
      'add and sign-in open ChatGPT\'s sign-in in your browser.',
      'While a ChatGPT plan is signed in, agents can\'t open terminals or coding tools under your account.',
      '--yes accepts that without asking. On Windows, manage ChatGPT plans in the Nessie Computer app.',
    ],
    examples: ['nessie-computer ai plans add "Work plan" --team "Sales · Acme"'],
  },
  {
    command: 'ai servers', summary: 'Model servers agents may use.',
    usage: [
      'nessie-computer ai servers [list] [--team <team>]',
      'nessie-computer ai servers add <name> <address> [--where this-computer|network] [--key-stdin] [--team <team>]',
      'nessie-computer ai servers check [--team <team>]',
      'nessie-computer ai servers remove <name> [--team <team>]',
    ],
    notes: ['--key-stdin reads an API key from standard input so it never appears in your shell history.'],
    examples: ['nessie-computer ai servers add "Studio" http://192.168.1.90:8080/v1 --where network --team Sales'],
  },
  {
    command: 'settings', summary: 'Computer-wide settings.',
    usage: [
      'nessie-computer settings',
      'nessie-computer settings auto-restart [on|off]',
      'nessie-computer settings updates',
      'nessie-computer settings updates check',
      'nessie-computer settings updates install',
      'nessie-computer settings updates automatic on|off',
      'nessie-computer settings logs',
    ],
    notes: [
      'auto-restart restarts a team if it stops. It covers the teams this command line runs as services;',
      'teams the app runs follow Settings in the app. "Open Nessie Computer when I log in" is set in the app.',
      'logs prints where the logs are.',
    ],
    examples: ['nessie-computer settings updates check', 'nessie-computer settings auto-restart off'],
  },
  {
    command: 'help', summary: 'Help for every command, or for one.',
    usage: ['nessie-computer help [<command>]', 'nessie-computer help plumbing', 'nessie-computer --version'],
    examples: ['nessie-computer help access programs', 'nessie-computer documents --help'],
  },
]
