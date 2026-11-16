import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { startDebugNessie } from './server.js'

/**
 * `debug-nessie`: run the debug control plane, and drive it
 * (`docs/debug-control-plane.md`). One process serves; every other command is
 * a request to it, so several terminals can work one control plane.
 */

const USAGE = `Debug control plane: a local stand-in for Nessie that a real Nessie Computer pairs with.

  debug-nessie serve [--port 5454] [--state <file>] [--unbound] [--concurrent] [--latency <ms>] [--clock-skew <ms>]
  debug-nessie status
  debug-nessie claim <code> [--team <name>] [--org <name>] [--no-team]
  debug-nessie call <computer> <operation> [<json arguments>]
  debug-nessie tools <computer> <server>
  debug-nessie session <tool> <computer> [--agent terminal|codex|claude] [--command <program> [--arg <a> ...]]
      [--cwd <folder>] [--root <name>] [--path <folder>] [--prompt <text>] [--id <sessionId>] [--message <text>]
      [--data <terminal text>] [--key Enter|Submit|CtrlC|Escape|Tab|Backspace|Up|Down] [--json <arguments>]
  debug-nessie revoke <computer>
  debug-nessie options [--latency <ms>] [--clock-skew <ms>] [--concurrent on|off] [--sessions bound|unbound_local]

<computer> is its id, the start of its id, or its name; it may be "" when only one is connected.
Every command takes --port (default NESSIE_API_PORT, else 5454) and --timeout <ms> for a command's answer.`

/** A terminal's named keys, encoded as Nessie's `terminal_session_write` encodes them. */
const TERMINAL_KEYS: Record<string, string> = {
  Enter: '\r', Submit: '\u001b[13;1u', CtrlC: '\u0003', Escape: '\u001b',
  Tab: '\t', Backspace: '\u007f', Up: '\u001b[A', Down: '\u001b[B',
}

const flag = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const flags = (args: string[], name: string): string[] => (
  args.flatMap((value, index) => (value === name && args[index + 1] !== undefined ? [args[index + 1]!] : []))
)
/** Arguments that are not a flag or a flag's value. */
const positional = (args: string[], booleans: readonly string[]): string[] => {
  const kept: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!
    if (value.startsWith('--')) { if (!booleans.includes(value)) index += 1; continue }
    kept.push(value)
  }
  return kept
}

const portOf = (args: string[]): number => Number(flag(args, '--port') ?? process.env.NESSIE_API_PORT ?? 5454)

/** One loopback request to the serving process; never anything but 127.0.0.1. */
const ask = async (port: number, route: string, body?: Record<string, unknown>): Promise<unknown> => {
  const text = await new Promise<string>((resolve, reject) => {
    const sent = request({ host: '127.0.0.1', port, path: `/debug/${route}`, method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    sent.on('error', () => reject(new Error(
      `No debug control plane answers on port ${port}. Start one with: debug-nessie serve`)))
    sent.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const answer = JSON.parse(text) as { data?: unknown; error?: { code: string; message: string } }
  if (answer.error) throw new Error(`${answer.error.code}: ${answer.error.message}`)
  return answer.data
}

/** A session tool answers with one text block holding JSON; shown parsed, which is how the agent would read it. */
const readable = (answer: unknown): unknown => {
  const data = answer as { result?: { content?: Array<{ text?: unknown }> } } | null
  const text = data?.result?.content?.[0]?.text
  if (typeof text !== 'string') return answer
  try {
    return { ...data, result: { ...data!.result, content: undefined, body: JSON.parse(text) as unknown } }
  } catch { return answer }
}

const print = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }

export const runDebugNessieCli = async (argv: string[]): Promise<void> => {
  const [command, ...rest] = argv
  const port = portOf(rest)
  const timeoutMs = flag(rest, '--timeout') === undefined ? undefined : Number(flag(rest, '--timeout'))
  if (command === 'serve') {
    const statePath = flag(rest, '--state') ?? join(homedir(), '.nessie-debug', `control-plane-${port}.json`)
    const nessie = await startDebugNessie({
      port, statePath, sessions: rest.includes('--unbound') ? 'unbound_local' : 'bound',
      concurrentPoll: rest.includes('--concurrent'), latencyMs: Number(flag(rest, '--latency') ?? 0),
      clockSkewMs: Number(flag(rest, '--clock-skew') ?? 0),
      log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
    })
    process.stderr.write(`Debug control plane on ${nessie.url} (state: ${statePath}).\n`
      + 'Pair a computer with it:\n'
      + `  NESSIE_EXECUTOR_ALLOW_LOCAL_API=1 NESSIE_API_PORT=${port} nessie-computer pairing-start --cli `
      + `--api ${nessie.url} --state-dir <dir> --json\n`
      + '  debug-nessie claim <code>\n'
      + `  NESSIE_EXECUTOR_ALLOW_LOCAL_API=1 NESSIE_API_PORT=${port} nessie-computer serve --state-dir <dir>\n`)
    await new Promise<void>((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
    await nessie.close()
    return
  }
  if (command === 'status') return print(await ask(port, 'state'))
  if (command === 'claim') {
    const [code] = positional(rest, ['--no-team'])
    if (!code) throw new Error('Name the code the computer shows.')
    return print(await ask(port, 'claim', { code, organization: flag(rest, '--org'),
      team: rest.includes('--no-team') ? null : flag(rest, '--team') }))
  }
  if (command === 'revoke') return print(await ask(port, 'revoke', { computer: positional(rest, [])[0] ?? '' }))
  if (command === 'options') {
    const latency = flag(rest, '--latency')
    const concurrent = flag(rest, '--concurrent')
    const skew = flag(rest, '--clock-skew')
    return print(await ask(port, 'options', { sessions: flag(rest, '--sessions'),
      ...(latency === undefined ? {} : { latencyMs: Number(latency) }),
      ...(skew === undefined ? {} : { clockSkewMs: Number(skew) }),
      ...(concurrent === undefined ? {} : { concurrentPoll: concurrent === 'on' }) }))
  }
  if (command === 'call') {
    const [computer, operationKey, json] = positional(rest, [])
    if (!operationKey) throw new Error('Name the computer and the operation, for example: call "" file.list \'{"path":"workspace"}\'')
    return print(readable(await ask(port, 'command', { computer: computer ?? '', operationKey,
      args: json ? JSON.parse(json) as unknown : {}, timeoutMs })))
  }
  if (command === 'tools') {
    const [computer, server] = positional(rest, [])
    if (!server) throw new Error('Name the computer and the local app, for example: tools "" coding-sessions')
    return print(await ask(port, 'command', { computer: computer ?? '', operationKey: 'mcp.tools', args: { server },
      timeoutMs }))
  }
  if (command === 'session') {
    const [tool, computer] = positional(rest, [])
    if (!tool) throw new Error('Name the session tool: start, list, status, read, send, interrupt, close or review.')
    const name = tool === 'read' ? 'terminal_read' : tool.startsWith('session_') || tool === 'terminal_read' ? tool
      : `session_${tool}`
    const program = flag(rest, '--command')
    const supplied = flag(rest, '--json')
    const key = flag(rest, '--key')
    if (key !== undefined && TERMINAL_KEYS[key] === undefined) {
      throw new Error(`Name one of these keys: ${Object.keys(TERMINAL_KEYS).join(', ')}.`)
    }
    // Typed into a terminal exactly as given, with no newline added; a key is a call of its own.
    const typed = key !== undefined ? TERMINAL_KEYS[key] : flag(rest, '--data')
    const toolArguments = supplied ? JSON.parse(supplied) as Record<string, unknown> : {
      ...(flag(rest, '--agent') ? { agent: flag(rest, '--agent') } : {}),
      ...(program ? { command: [program, ...flags(rest, '--arg')] } : {}),
      ...(flag(rest, '--cwd') ? { cwd: flag(rest, '--cwd') } : {}),
      ...(flag(rest, '--root') ? { root: flag(rest, '--root') } : {}),
      ...(flag(rest, '--path') ? { path: flag(rest, '--path') } : {}),
      ...(flag(rest, '--prompt') ? { prompt: flag(rest, '--prompt') } : {}),
      ...(flag(rest, '--id') ? { sessionId: flag(rest, '--id') } : {}),
      ...(flag(rest, '--message') ? { message: flag(rest, '--message') } : {}),
      ...(typed !== undefined ? { message: typed, terminal: true } : {}),
    }
    return print(readable(await ask(port, 'command', { computer: computer ?? '', operationKey: 'mcp.call',
      args: { server: 'coding-sessions', tool: name, arguments: toolArguments }, timeoutMs })))
  }
  process.stdout.write(`${USAGE}\n`)
  if (command !== undefined && command !== 'help' && command !== '--help') process.exitCode = 2
}
