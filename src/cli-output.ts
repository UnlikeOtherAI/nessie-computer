import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'

/**
 * How the `nessie-computer` commands talk to the person running them: what
 * they print, how they ask, and the exit code a failure ends with (the Command
 * reference's 0 worked, 1 refused or failed, 2 typed wrong, 3 timed out).
 */

/** The command was typed wrong: exit code 2. `command` names the help that explains it. */
export class CliUsageError extends Error {
  readonly code = 'USAGE'
  constructor(message: string, readonly command?: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

/** Refused or failed, with a stable code for `--json`: exit code 1. */
export class CliRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CliRefusal'
  }
}

/** Waiting ran out of time: exit code 3. */
export class CliTimeout extends Error {
  readonly code = 'TIMED_OUT'
  constructor(message: string) {
    super(message)
    this.name = 'CliTimeout'
  }
}

export const EXIT = { ok: 0, failed: 1, usage: 2, timedOut: 3 } as const

/** Everything a command reads from or writes to the outside world, so a test can stand in for it. */
export type CliContext = {
  out: (text: string) => void
  err: (text: string) => void
  stdin: NodeJS.ReadableStream
  /** Standard input and output are a terminal: a person can be asked. */
  interactive: boolean
  ask: (question: string) => Promise<string>
  platform: NodeJS.Platform
  home: string
  now: () => Date
  sleep: (milliseconds: number) => Promise<void>
}

export const processContext = (): CliContext => ({
  out: (text) => { process.stdout.write(text) },
  err: (text) => { process.stderr.write(text) },
  stdin: process.stdin,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: async (question) => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout })
    try { return await terminal.question(question) } finally { terminal.close() }
  },
  platform: process.platform,
  home: homedir(),
  now: () => new Date(),
  sleep: (milliseconds) => new Promise((finish) => setTimeout(finish, milliseconds)),
})

/** One JSON document on standard output. */
export const printJson = (context: CliContext, value: unknown): void => {
  context.out(`${JSON.stringify(value, undefined, 2)}\n`)
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/u.test(code) ? code : 'EXECUTOR_COMMAND_FAILED'
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Reports a failure and returns its exit code. With `--json` the failure is
 * one JSON document on standard output, `{ error: { code, message } }`, the
 * shape the plumbing verbs already use; otherwise a sentence on standard error.
 */
export const reportFailure = (context: CliContext, json: boolean, error: unknown): number => {
  const exit = error instanceof CliUsageError ? EXIT.usage : error instanceof CliTimeout ? EXIT.timedOut : EXIT.failed
  if (json) {
    context.out(`${JSON.stringify({ error: { code: codeOf(error), message: messageOf(error) } })}\n`)
  } else {
    const help = error instanceof CliUsageError
      ? `\nSee nessie-computer help${error.command ? ` ${error.command}` : ''}.` : ''
    context.err(`${messageOf(error)}${help}\n`)
  }
  return exit
}

/** "1 team", "2 teams". */
export const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** A list in a sentence: "a", "a and b", "a, b and c"; `empty` when there is nothing. */
export const listed = (items: readonly string[], empty = 'none'): string => {
  if (items.length === 0) return empty
  if (items.length === 1) return items[0]!
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** Rows as aligned columns, two spaces apart. */
export const columns = (rows: readonly (readonly string[])[], indent = ''): string => {
  const widths = rows.reduce<number[]>((found, row) => row.map((cell, index) => Math.max(found[index] ?? 0, cell.length)), [])
  return rows.map((row) => `${indent}${row.map((cell, index) => (index === row.length - 1 ? cell
    : cell.padEnd(widths[index]!))).join('  ')}`.trimEnd()).join('\n')
}
