import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'

import { localTerminalCommandRefusal, type LocalCommandPolicy, type TerminalCommandRefusal } from '../command-policy.js'
import { argumentsFor, CodingBridgeError, invalidArguments, requiredText } from './bridge-tools.js'
import { absoluteDirectory } from './program-path.js'

/**
 * What a terminal session starts, from `session_start`'s arguments: the
 * program and arguments the agent names, in the folder it names — the
 * person's home folder when it names none, as a new terminal window opens.
 *
 * This computer's command rules decide whether the program may start. They
 * reach the bridge only from the daemon, in reserved `_meta` the model cannot
 * write, so a start without them is refused rather than read as permitted.
 */
export type TerminalLaunch = { command: string[]; cwd: string; title: string }

/** The guest command lane's own argv bounds: a program and 64 arguments, 24 KiB in all. */
const COMMAND_ENTRIES = 65
const ENTRY_MAX = 4_096
const COMMAND_BYTES = 24_576
const CWD_MAX = 4_096

const REFUSED: Record<TerminalCommandRefusal, string> = {
  denied: 'This computer\'s command rules deny that command.',
  not_allowlisted: 'This computer allows only its allowlisted commands, and that command is not one of them.',
  path_needs_allow_all: 'This computer allows only its allowlisted commands: name the program without a path, '
    + 'and the session finds it on the PATH.',
  invalid_program: 'command[0] must be a program name or the absolute path of one.',
}

/** A title that names the program without carrying a host path or an argument. */
const programTitle = (program: string): string => {
  const name = program.split(/[\\/]/u).at(-1)!.replace(/\.(?:exe|com)$/iu, '')
  return name.length > 120 ? `${name.slice(0, 119)}…` : name
}

export const terminalLaunch = async (
  value: unknown, rules: LocalCommandPolicy | undefined,
): Promise<TerminalLaunch> => {
  const args = argumentsFor(value, ['agent', 'command', 'cwd', 'title'])
  const command = args.command
  if (!Array.isArray(command) || command.length === 0 || command.length > COMMAND_ENTRIES
    || command.some((entry) => typeof entry !== 'string' || entry.length > ENTRY_MAX || entry.includes('\0'))
    || Buffer.byteLength(command.join('\0')) > COMMAND_BYTES) {
    return invalidArguments('command is the program, then each of its arguments: a list of 1 to 65 strings.')
  }
  const argv = command as string[]
  if (!rules) {
    throw new CodingBridgeError(
      'coding_session_command_rules_missing',
      'Terminal sessions start only through the executor, which applies this computer\'s command rules.',
    )
  }
  // CreateProcess runs no script without its interpreter, and there is no shell in between.
  if (process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/iu.test(argv[0]!)) {
    invalidArguments('command names a script. Start its interpreter instead, such as cmd.exe /c or powershell -File.')
  }
  const refusal = localTerminalCommandRefusal(rules, argv)
  if (refusal) throw new CodingBridgeError('coding_session_command_refused', REFUSED[refusal])
  const cwd = args.cwd === undefined ? homedir() : requiredText(args.cwd, 'cwd', CWD_MAX)
  if (!absoluteDirectory(cwd, process.platform)) invalidArguments('cwd must be the absolute path of a folder on this computer.')
  if (!(await stat(cwd).then((info) => info.isDirectory(), () => false))) {
    throw new CodingBridgeError('coding_session_cwd_unavailable', 'cwd is not an existing folder on this computer.')
  }
  const title = args.title === undefined ? programTitle(argv[0]!) : requiredText(args.title, 'title', 120).trim()
  return { command: argv, cwd, title }
}
