import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { HELP_ENTRIES, HELP_GROUPS } from '../src/cli-help-entries.js'
import { helpText, PLUMBING_HELP } from '../src/cli-help.js'
import { parseCliOptions } from '../src/cli-options.js'
import type { CliContext } from '../src/cli-output.js'
import { isUserCommand, runUserCli } from '../src/cli-user.js'

/**
 * The help is the Command reference: every usage line in one is a line of the
 * other, every documented example resolves to a command with help, and every
 * command's help runs. A command added, renamed or dropped in either place
 * without the other fails here.
 */

const reference = readFileSync(fileURLToPath(new URL('../docs/wiki/Command-reference.md', import.meta.url)), 'utf8')
const guide = readFileSync(fileURLToPath(new URL('../docs/wiki/Command-line.md', import.meta.url)), 'utf8')

const normalize = (line: string): string => line.replace(/\s#.*$/u, '').replace(/\s+/gu, ' ').trim()

/** The `nessie-computer …` lines of a page's code blocks, outside its Plumbing section. */
const codeLines = (page: string): string[] => {
  const before = page.split(/^## Plumbing/mu)[0]!
  return [...before.matchAll(/```sh\n([\s\S]*?)```/gu)].flatMap((block) => block[1]!.split('\n'))
    .map((line) => normalize(line.replace(/^\$ /u, ''))).filter((line) => line.startsWith('nessie-computer'))
}

/** Shell words, honouring double quotes. */
const words = (line: string): string[] => [...line.matchAll(/"([^"]*)"|(\S+)/gu)].map((match) => match[1] ?? match[2]!)

const capture = (): { context: CliContext; out: () => string; err: () => string } => {
  let out = ''
  let err = ''
  return {
    out: () => out, err: () => err,
    context: { out: (text) => { out += text }, err: (text) => { err += text },
      stdin: Readable.from([]), interactive: false,
      ask: async () => '', platform: process.platform, home: tmpdir(), now: () => new Date(), sleep: async () => undefined },
  }
}

test('every usage line in the help is in the Command reference, and every reference line is in the help', () => {
  const documented = new Set(codeLines(reference))
  const helped = new Set(HELP_ENTRIES.flatMap((entry) => entry.usage.map(normalize)))
  assert.deepEqual([...helped].filter((line) => !documented.has(line)), [], 'help lines missing from the Command reference')
  assert.deepEqual([...documented].filter((line) => !helped.has(line)), [], 'Command reference lines missing from the help')
})

test('every grouped command has help, and every help entry is listed in a group', () => {
  const grouped = HELP_GROUPS.flatMap((group) => group.commands)
  assert.deepEqual(grouped.filter((command) => !HELP_ENTRIES.some((entry) => entry.command === command)), [])
  assert.deepEqual(HELP_ENTRIES.map((entry) => entry.command).filter((command) => !grouped.includes(command)), [])
})

test('each command answers help <command> and <command> --help with its usage and examples', async () => {
  for (const entry of HELP_ENTRIES) {
    for (const args of [['help', ...entry.command.split(' ')], [...entry.command.split(' '), '--help']]) {
      const run = capture()
      assert.equal(await runUserCli(args, { context: run.context }), 0, `${args.join(' ')}: ${run.err()}`)
      for (const line of [...entry.usage, ...entry.examples]) assert.ok(run.out().includes(line), `${args.join(' ')} lacks ${line}`)
    }
  }
})

test('every example in the help and the Command line guide is a command with help', () => {
  const examples = [...HELP_ENTRIES.flatMap((entry) => entry.examples), ...codeLines(guide)]
  for (const example of examples) {
    const parsed = parseCliOptions(words(example).slice(1))
    assert.ok(isUserCommand(words(example).slice(1)), `${example} is not a user command`)
    assert.doesNotThrow(() => helpText(parsed.words), `${example} has no help`)
  }
})

test('the help speaks the window\'s words', () => {
  const text = [helpText([]), ...HELP_ENTRIES.map((entry) => helpText(entry.command.split(' ')))].join('\n')
  for (const banned of [/\bexecutor\b/iu, /\bdaemon\b/iu, /\btray\b/iu, /\ballowlist\b/iu, /\bpairing\b(?! code)/iu]) {
    assert.doesNotMatch(text, banned)
  }
})

test('help plumbing names every plumbing command the Command reference lists', () => {
  const table = reference.split(/^## Plumbing/mu)[1]!
  const verbs = [...table.matchAll(/^\| `([^`]+)`/gmu)].map((row) => row[1]!.split(/[ ,]+/u)[0]!)
  assert.ok(verbs.length > 5)
  for (const verb of verbs) assert.ok(PLUMBING_HELP.includes(verb.replace(/\*$/u, '')), `help plumbing lacks ${verb}`)
})

test('an unknown command is typed wrong: exit 2 and a pointer to help', async () => {
  const run = capture()
  assert.equal(await runUserCli(['acess', 'show'], { context: run.context }), 2)
  assert.match(run.err(), /nessie-computer help/u)
  const option = capture()
  assert.equal(await runUserCli(['status', '--colour'], { context: option.context }), 2)
  const json = capture()
  assert.equal(await runUserCli(['status', '--colour', '--json'], { context: json.context }), 2)
  assert.equal(JSON.parse(json.out()).error.code, 'USAGE')
})

test('the real entry routes help and --version, and leaves plumbing as it was', () => {
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
  const env = { ...process.env }
  delete env.NESSIE_EXECUTOR_PACKAGED_CLI
  const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', entry, ...args],
    { encoding: 'utf8', env, timeout: 60_000 })
  const help = cli(['help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /^Nessie Computer lets agents/u)
  const version = cli(['--version'])
  assert.match(version.stdout, /^nessie-computer \S+\n$/u)
  // A malformed plumbing line answers exactly as it always has.
  const plumbing = cli(['describe'])
  assert.equal(plumbing.status, 1)
  assert.match(plumbing.stderr, /^Usage: nessie-executor login/u)
  const typo = cli(['acess', 'show'])
  assert.equal(typo.status, 2)
  assert.match(typo.stderr, /^nessie-computer has no command "acess show"\.\nSee nessie-computer help\.\n$/u)
})
