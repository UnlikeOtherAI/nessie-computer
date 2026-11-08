import { CliUsageError } from './cli-output.js'

/**
 * A `nessie-computer` command line, read once: the command words in order and
 * the options. `--team`, `--json` and `--help` are accepted by every command;
 * each command names the other options it takes ({@link acceptOnly}).
 */
export type CliOptions = {
  words: string[]
  team?: string
  json: boolean
  help: boolean
  values: Map<string, string>
  flags: Set<string>
}

const VALUE_OPTIONS = new Set(['--team', '--server', '--name', '--folder', '--where'])
const FLAG_OPTIONS = new Set(['--json', '--help', '--yes', '--no-wait', '--add-existing-files', '--key-stdin'])

export const parseCliOptions = (args: readonly string[]): CliOptions => {
  const words: string[] = []
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '-h') {
      flags.add('--help')
      continue
    }
    if (argument === '--') {
      words.push(...args.slice(index + 1))
      break
    }
    if (!argument.startsWith('--')) {
      words.push(argument)
      continue
    }
    const equals = argument.indexOf('=')
    const name = equals < 0 ? argument : argument.slice(0, equals)
    if (FLAG_OPTIONS.has(name) && equals < 0) {
      flags.add(name)
      continue
    }
    if (!VALUE_OPTIONS.has(name)) throw new CliUsageError(`${argument} is not an option of nessie-computer.`)
    const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1)
    if (value === undefined || value === '' || (equals < 0 && value.startsWith('--'))) {
      throw new CliUsageError(`${name} needs a value.`)
    }
    if (values.has(name)) throw new CliUsageError(`Give ${name} once.`)
    values.set(name, value)
    if (equals < 0) index += 1
  }
  return {
    words, values, flags, json: flags.has('--json'), help: flags.has('--help'),
    ...(values.has('--team') ? { team: values.get('--team')! } : {}),
  }
}

/** Refuses any option outside `allowed` and the three every command takes. */
export const acceptOnly = (options: CliOptions, command: string, allowed: readonly string[] = []): void => {
  const accepted = new Set(['--team', '--json', '--help', ...allowed])
  for (const name of [...options.values.keys(), ...options.flags]) {
    if (!accepted.has(name)) throw new CliUsageError(`nessie-computer ${command} doesn't take ${name}.`, command)
  }
}

/** The command words after `consumed`, refusing more than `most`. */
export const operands = (options: CliOptions, consumed: number, most: number, command: string): string[] => {
  const rest = options.words.slice(consumed)
  if (rest.length > most) throw new CliUsageError(`Too many words after nessie-computer ${command}: ${rest.slice(most).join(' ')}.`, command)
  return rest
}

/** `on` or `off`, or a usage error naming the command. */
export const onOff = (value: string | undefined, command: string): boolean => {
  if (value !== 'on' && value !== 'off') throw new CliUsageError(`Use on or off: nessie-computer ${command} on|off.`, command)
  return value === 'on'
}
