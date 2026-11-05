#!/usr/bin/env node
/**
 * A scripted coding agent that speaks Claude Code's `-p` stream-json protocol
 * and Codex's `exec --json` protocol, so the coding-sessions bridge is proved
 * against real processes rather than stubs. The shapes mirror the transcripts
 * captured from claude 2.1.280 and codex-cli 0.155.1.
 *
 * Which protocol it speaks follows from its argv, exactly as the real CLIs are
 * invoked: `--version`, `--help` (the help texts captured from those versions,
 * in `agent-help/`; `NESSIE_SCRIPTED_HELP=older` answers with the edited
 * Claude help that lacks `--permission-prompts`), `auth status` /
 * `login status`, `-p …` (Claude), or `exec …` (Codex). What a turn does is
 * chosen by directives in the message:
 *
 *   #sleep=<ms>   a foreground tool call that takes that long (interruptible;
 *                 a follow-up written meanwhile folds into the running turn)
 *   #hold=<name>  the same foreground tool call, held until the test writes
 *                 `release-<name>` into the record directory — for a test that
 *                 must observe the turn while it runs, however slowly the
 *                 bridge or host starts
 *   #quiet=<name> (Claude) says nothing about the turn, not even its init,
 *                 until the test writes `release-<name>`: an agent that has
 *                 the message but has not yet confirmed its session
 *   #fork         starts a grandchild that escapes the process group (a
 *                 detached node sleeping for ten minutes) and records its pid
 *   #path         prints host paths: the working folder, home, ~/.claude
 *   #env          records its whole environment and reports a few variables
 *   #test         runs a failing test command (exit code 3)
 *   #deny         reports a permission denial
 *   #background   leaves a background task whose completion starts a turn nobody asked for
 *   #stubborn     acknowledges an interrupt and carries on regardless (with #sleep)
 *   #secret       prints a GitHub token and a value the configuration set, as `gh auth token` and `printenv` would
 *   #identity     prints the OS user and host names, as git, npm and a shell prompt do
 *   #codexfail    (Codex) the usage-limit failure codex-cli 0.155.1 prints
 *
 * NESSIE_SCRIPTED_RECORD_DIR, when set, receives `agents.jsonl` (one line per
 * process start and exit, and per message a Claude process receives),
 * grandchild pid files and environment dumps. NESSIE_SCRIPTED_HOLD_INIT=<name>
 * holds a Claude process's `initialize` answer until the test writes
 * `release-<name>`: an agent still booting, which has no message yet.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const recordDir = process.env.NESSIE_SCRIPTED_RECORD_DIR
const record = (entry) => {
  if (recordDir) appendFileSync(join(recordDir, 'agents.jsonl'), `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
}
const send = (event) => { process.stdout.write(`${JSON.stringify(event)}\n`) }
const delay = (ms) => new Promise((settle) => { setTimeout(settle, ms) })
// Resolves once the test releases the hold, or stops looking when the turn
// holding it ends another way (an interrupt).
const released = async (name, holder) => {
  while (turn === holder && !existsSync(join(recordDir, `release-${name}`))) await delay(50)
}
const option = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const fork = () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  })
  child.unref()
  if (recordDir) writeFileSync(join(recordDir, `grandchild-${child.pid}.pid`), String(child.pid))
}

const environmentReport = () => {
  if (recordDir) writeFileSync(join(recordDir, `env-${process.pid}.json`), JSON.stringify(process.env))
  const pick = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'NESSIE_EXECUTOR_PACKAGED_CLI',
    'NESSIE_CODING_SESSIONS_CONFIG_DIGEST', 'SCRIPTED_SET']
  return JSON.stringify(Object.fromEntries(pick.map((name) => [name, process.env[name] ?? null])))
}

if (argv[0] === '--version') {
  process.stdout.write('9.9.9 (Scripted Coding Agent)\n')
  process.exit(0)
}
if (argv.at(-1) === '--help') {
  const help = argv[0] !== 'exec'
    ? process.env.NESSIE_SCRIPTED_HELP === 'older' ? 'claude-older.txt' : 'claude-2.1.280.txt'
    : argv[1] === 'resume' ? 'codex-0.155.1-exec-resume.txt' : 'codex-0.155.1-exec.txt'
  process.stdout.write(readFileSync(new URL(`./agent-help/${help}`, import.meta.url), 'utf8'))
  process.exit(0)
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = process.env.NESSIE_SCRIPTED_LOGGED_OUT !== '1'
  process.stdout.write(`${JSON.stringify({ loggedIn, email: 'person@example.com', orgName: 'Private Org' })}\n`)
  process.exit(loggedIn ? 0 : 1)
}
if (argv[0] === 'login' && argv[1] === 'status') {
  const loggedIn = process.env.NESSIE_SCRIPTED_LOGGED_OUT !== '1'
  process.stderr.write(loggedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n')
  process.exit(loggedIn ? 0 : 1)
}

if (argv.includes('exec')) {
  // ---- Codex: one process per turn, the prompt on stdin. ----
  const resumeIndex = argv.indexOf('resume')
  const threadId = resumeIndex >= 0 ? argv[resumeIndex + 1] : randomUUID()
  record({ agent: 'codex', event: 'start', threadId, resume: resumeIndex >= 0, cwd: process.cwd() })
  process.on('exit', () => record({ agent: 'codex', event: 'exit' }))
  let prompt = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) prompt += chunk
  send({ type: 'thread.started', thread_id: threadId })
  send({ type: 'turn.started' })
  if (prompt.includes('#codexfail')) {
    const message = 'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.'
    send({ type: 'error', message })
    send({ type: 'turn.failed', error: { message } })
    process.exit(1)
  }
  if (prompt.includes('#fork')) fork()
  send({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: `ls ${process.cwd()}`, status: 'in_progress' } })
  const sleep = /#sleep=(\d+)/u.exec(prompt)
  if (sleep) await delay(Number(sleep[1]))
  send({
    type: 'item.completed',
    item: {
      id: 'item_0', type: 'command_execution', command: `ls ${process.cwd()}`, aggregated_output: `listed ${process.cwd()}`,
      exit_code: 0, status: 'completed',
    },
  })
  send({ type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'thinking' } })
  send({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: `Codex done: ${prompt.trim()}` } })
  send({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })
  process.exit(0)
}

// ---- Claude Code: one long-lived process, stream-json over stdio. ----
const sessionId = option('--resume') ?? option('--session-id') ?? randomUUID()
record({ agent: 'claude', event: 'start', sessionId, resume: argv.includes('--resume'), cwd: process.cwd(), argv })
process.on('exit', () => record({ agent: 'claude', event: 'exit' }))

let totalCost = 0
let turn
const queued = []
let inputEnded = false

const lifecycle = (uuid, state) => send({
  type: 'command_lifecycle', command_uuid: uuid, state, uuid: randomUUID(), session_id: sessionId,
})
const init = () => send({
  type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model: 'scripted-model',
  permissionMode: 'default', tools: ['Bash', 'Read'], mcp_servers: [{ name: 'claude.ai Private Docs', status: 'connected' }],
  memory_paths: { auto: join(homedir(), '.claude', 'projects', 'scripted', 'memory') },
})
const replay = (message) => send({
  type: 'user', message: { role: 'user', content: [{ type: 'text', text: message.text }] },
  session_id: sessionId, parent_tool_use_id: null, uuid: message.uuid, isReplay: true,
})
const tool = async (name, input, output, isError = false) => {
  const id = `toolu_${randomUUID().slice(0, 8)}`
  send({ type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
  send({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: output, is_error: isError }] } })
}
const result = (text, extra = {}) => {
  totalCost += 0.01
  send({
    type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: text, session_id: sessionId,
    total_cost_usd: totalCost, duration_ms: 5, permission_denials: [], ...extra,
  })
}

const runTurn = async (first) => {
  const messages = [first]
  const current = { messages, interrupted: false, wake: undefined, stubborn: first.text.includes('#stubborn') }
  turn = current
  const quiet = /#quiet=([\w-]+)/u.exec(first.text)
  if (quiet) await released(quiet[1], current)
  lifecycle(first.uuid, 'started')
  init()
  send({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.4 } } } })
  replay(first)
  const text = () => messages.map((message) => message.text).join(' ')
  const extra = {}
  if (text().includes('#fork')) fork()
  if (text().includes('#path')) {
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Working in ${process.cwd()}; home is ${homedir()}; memory under ~/.claude/projects.` }] } })
    await tool('Read', { file_path: join(process.cwd(), 'README.md') }, `1\tread from ${join(process.cwd(), 'README.md')}`)
  }
  if (text().includes('#env')) send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: environmentReport() }] } })
  if (text().includes('#test')) await tool('Bash', { command: 'pnpm test' }, 'Exit code 3\nFAIL src/app.test.ts', true)
  if (text().includes('#secret')) {
    const token = `ghp_${'Z9y8'.repeat(9)}`
    await tool('Bash', { command: `export GH_TOKEN=${token}` }, '')
    await tool('Bash', { command: 'gh auth token' }, token)
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `SCRIPTED_SET is ${process.env.SCRIPTED_SET}` }] } })
  }
  if (text().includes('#identity')) {
    const user = userInfo().username
    await tool('Bash', { command: 'git commit -m wip' }, `Exit code 128\nAuthor identity unknown\nfatal: unable to auto-detect email address (got '${user}@${hostname()}.(none)')`, true)
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `npm whoami says ${user}; the prompt reads ${user}@${hostname()} MINGW64` }] } })
  }
  if (text().includes('#deny')) {
    send({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'toolu_denied', message: 'denied' })
    extra.permission_denials = [{ tool_name: 'Bash', tool_use_id: 'toolu_denied', tool_input: { command: 'git push --force' } }]
  }
  const sleep = /#sleep=(\d+)/u.exec(text())
  const hold = /#hold=([\w-]+)/u.exec(text())
  if (sleep || hold) {
    const id = `toolu_${randomUUID().slice(0, 8)}`
    const command = sleep ? `sleep ${sleep[1]}` : `wait-for ${hold[1]}`
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
    send({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: id, is_backgrounded: false })
    const finished = sleep ? delay(Number(sleep[1])) : released(hold[1], current)
    await Promise.race([finished, new Promise((settle) => { current.wake = settle })])
    if (current.interrupted) {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, terminal_reason: 'aborted_tools', session_id: sessionId, total_cost_usd: totalCost, permission_denials: [] })
      for (const message of messages) lifecycle(message.uuid, 'completed')
      turn = undefined
      return drain()
    }
    send({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'slept', is_error: false }] } })
    // The tool boundary: follow-ups written meanwhile fold into this turn.
    while (queued.length > 0) {
      const next = queued.shift()
      messages.push(next)
      lifecycle(next.uuid, 'started')
      replay(next)
    }
  }
  const background = text().includes('#background')
  if (background) send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg1', task_type: 'local_bash' }] })
  send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Done: ${messages.map((message) => message.text).join(' | ')}` }] } })
  result(`Done: ${messages.map((message) => message.text).join(' | ')}`, extra)
  for (const message of messages) lifecycle(message.uuid, 'completed')
  turn = undefined
  if (background) {
    await delay(800)
    send({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', output_file: join(homedir(), '.claude', 'task.output'), summary: 'Background command "sleep" completed (exit code 0)' })
    send({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    init()
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The background task finished.' }] } })
    result('The background task finished.', { origin: { kind: 'task-notification' } })
  }
  return drain()
}

const drain = () => {
  if (turn) return undefined
  const next = queued.shift()
  if (next) return runTurn(next)
  if (inputEnded) process.exit(0)
  return undefined
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.type === 'control_request') {
    const subtype = message.request?.subtype
    if (subtype === 'initialize') {
      const answer = () => send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], pid: process.pid, account: { email: 'person@example.com', organization: 'Private Org' }, session_state: 'idle' } } })
      const held = process.env.NESSIE_SCRIPTED_HOLD_INIT
      if (held) void (async () => { while (!existsSync(join(recordDir, `release-${held}`))) await delay(50) })().then(answer)
      else answer()
    } else if (subtype === 'interrupt') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { still_queued: [] } } })
      if (turn && !turn.stubborn) {
        turn.interrupted = true
        turn.wake?.()
      }
    } else if (subtype === 'end_session') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } })
      setTimeout(() => process.exit(0), 20)
    }
    return
  }
  if (message.type !== 'user') return
  const content = message.message?.content
  const text = typeof content === 'string' ? content : content?.map((block) => block.text ?? '').join('') ?? ''
  const entry = { uuid: message.uuid ?? randomUUID(), text }
  record({ agent: 'claude', event: 'message', text })
  lifecycle(entry.uuid, 'queued')
  queued.push(entry)
  if (!turn) void drain()
}).on('close', () => {
  inputEnded = true
  if (!turn && queued.length === 0) process.exit(0)
})
