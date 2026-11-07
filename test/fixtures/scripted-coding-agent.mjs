#!/usr/bin/env node
/**
 * A scripted coding agent that speaks Claude Code's `-p` stream-json protocol
 * and Codex's `app-server` JSON-RPC protocol, so the coding-sessions bridge is
 * proved against real processes rather than stubs. The shapes mirror the
 * transcripts captured from claude 2.1.280/2.1.319 and codex-cli 0.166.0.
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
 *   #codexfail    (Codex) the usage-limit failure, as a failed turn
 *   #permit       asks permission to run `git push --force` (Claude: a `can_use_tool` control request;
 *                 Codex: `item/commandExecution/requestApproval`) and records the answer
 *   #question     asks a question (Claude: AskUserQuestion; Codex: `item/tool/requestUserInput`)
 *   #secret-tool  calls the session's `request_secret` MCP server it was given and records the result
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
// The turn under way, in whichever protocol this process speaks.
let turn
// Resolves once the test releases the hold, or stops looking when the turn
// holding it ends another way (an interrupt).
const released = async (name, holder) => {
  while (turn === holder && !existsSync(join(recordDir, `release-${name}`))) await delay(50)
}
const option = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

/** Calls the session's `request_secret` server exactly as an agent's MCP client would, over its stdio. */
const callSecretTool = (server, args) => new Promise((resolve) => {
  const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const answers = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line)
      answers.get(message.id)?.(message)
    } catch { /* not ours */ }
  })
  const call = (id, method, params) => new Promise((settle) => {
    answers.set(id, settle)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  void (async () => {
    await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scripted', version: '1' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const answer = await call(2, 'tools/call', { name: 'request_secret', arguments: args })
    child.kill()
    resolve(answer.result ?? { isError: true, content: [{ type: 'text', text: JSON.stringify(answer.error) }] })
  })()
})
const SECRET_ARGS = { name: 'Stripe test key', reason: 'The checkout tests call Stripe.', destination: '.env.local', envName: 'STRIPE_KEY' }

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
  const help = argv[0] === 'app-server' ? 'codex-0.166.0-app-server.txt' : argv[0] !== 'exec'
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

if (argv.includes('app-server')) {
  // ---- Codex: one app-server per session, JSON-RPC over stdio. ----
  record({ agent: 'codex', event: 'start', cwd: process.cwd() })
  process.on('exit', () => record({ agent: 'codex', event: 'exit' }))
  let threadId
  let config = {}
  let nextId = 1000
  const waiting = new Map()
  const reply = (id, result) => send({ id, result })
  const notify = (method, params) => send({ method, params })
  const ask = (method, params) => new Promise((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    send({ id, method, params })
  })
  const runTurn = async (current, prompt) => {
    turn = current
    const { id } = current
    notify('turn/started', { threadId, turn: { id, status: 'inProgress', items: [] } })
    const finish = (status, extra = {}) => {
      notify('turn/completed', { threadId, turn: { id, status, items: [], ...extra } })
      turn = undefined
    }
    if (prompt.includes('#codexfail')) {
      const message = 'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.'
      notify('error', { threadId, turnId: id, willRetry: false, error: { message } })
      return finish('failed', { error: { message } })
    }
    if (prompt.includes('#fork')) fork()
    const command = `ls ${process.cwd()}`
    notify('item/started', { threadId, turnId: id, item: { id: 'item_0', type: 'commandExecution', command, status: 'inProgress' } })
    if (prompt.includes('#permit')) {
      notify('item/started', { threadId, turnId: id, item: { id: 'exec-1', type: 'commandExecution', command: 'git push --force',
        status: 'inProgress' } })
      const answer = await ask('item/commandExecution/requestApproval', { threadId, turnId: id, itemId: 'exec-1',
        command: "/bin/zsh -lc 'git push --force'", cwd: process.cwd(), reason: 'Publish the branch.',
        commandActions: [{ type: 'unknown', command: 'git push --force' }], startedAtMs: Date.now(),
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] })
      record({ agent: 'codex', event: 'permission', answer })
      if (answer.decision === 'cancel' || current.interrupted) return finish('interrupted')
    }
    if (prompt.includes('#question')) {
      const answer = await ask('item/tool/requestUserInput', { threadId, turnId: id, itemId: 'ask-1', isBlocking: true,
        questions: [{ id: 'db', header: 'Database', question: 'Which database?', isOther: true,
          options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite', description: 'One file' }] }] })
      record({ agent: 'codex', event: 'question', answer })
      if (current.interrupted) return finish('interrupted')
    }
    if (prompt.includes('#secret-tool')) {
      const prefix = 'mcp_servers.nessie_session.'
      const result = await callSecretTool({ command: config[`${prefix}command`], args: config[`${prefix}args`] }, SECRET_ARGS)
      record({ agent: 'codex', event: 'secret', result, timeout: config[`${prefix}tool_timeout_sec`] })
    }
    const sleep = /#sleep=(\d+)/u.exec(prompt)
    const hold = /#hold=([\w-]+)/u.exec(prompt)
    if (sleep || hold) {
      const finished = sleep ? delay(Number(sleep[1])) : released(hold[1], current)
      await Promise.race([finished, new Promise((settle) => { current.wake = settle })])
    }
    if (current.interrupted) return finish('interrupted')
    notify('item/completed', { threadId, turnId: id, item: { id: 'item_0', type: 'commandExecution', command,
      aggregatedOutput: `listed ${process.cwd()}`, exitCode: 0, status: 'completed' } })
    notify('item/completed', { threadId, turnId: id, item: { id: 'item_1', type: 'reasoning', summary: ['thinking'] } })
    notify('item/completed', { threadId, turnId: id, item: { id: 'item_2', type: 'agentMessage', text: `Codex done: ${prompt.trim()}` } })
    return finish('completed')
  }
  createInterface({ input: process.stdin }).on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.method === undefined) {
      waiting.get(message.id)?.(message.result ?? { error: message.error })
      waiting.delete(message.id)
      return
    }
    const { id, method, params = {} } = message
    if (method === 'initialize') reply(id, { userAgent: 'scripted' })
    else if (method === 'thread/start' || method === 'thread/resume') {
      threadId = method === 'thread/resume' ? params.threadId : randomUUID()
      config = params.config ?? {}
      record({ agent: 'codex', event: 'thread', threadId, resume: method === 'thread/resume', sandbox: params.sandbox,
        approvalPolicy: params.approvalPolicy, configKeys: Object.keys(config) })
      reply(id, { thread: { id: threadId }, approvalPolicy: params.approvalPolicy, sandbox: { type: 'readOnly' } })
    } else if (method === 'turn/start') {
      const prompt = params.input?.map((part) => part.text ?? '').join('') ?? ''
      record({ agent: 'codex', event: 'message', text: prompt })
      const current = { id: randomUUID(), interrupted: false, wake: undefined }
      reply(id, { turn: { id: current.id, status: 'inProgress', items: [] } })
      void runTurn(current, prompt)
    } else if (method === 'turn/interrupt') {
      if (turn && turn.id === params.turnId) {
        turn.interrupted = true
        turn.wake?.()
        // Pending prompts are withdrawn with the turn.
        for (const [requestId, resolve] of waiting) {
          notify('serverRequest/resolved', { threadId, requestId })
          resolve({ decision: 'cancel', answers: {} })
          waiting.delete(requestId)
        }
      }
      reply(id, {})
    } else if (method === 'turn/steer') {
      record({ agent: 'codex', event: 'steer', text: params.input?.map((part) => part.text).join('') })
      reply(id, { turnId: params.expectedTurnId })
    } else if (id !== undefined) send({ id, error: { code: -32601, message: 'unknown method' } })
  }).on('close', () => process.exit(0))
} else {
// ---- Claude Code: one long-lived process, stream-json over stdio. ----
const sessionId = option('--resume') ?? option('--session-id') ?? randomUUID()
record({ agent: 'claude', event: 'start', sessionId, resume: argv.includes('--resume'), cwd: process.cwd(), argv })
process.on('exit', () => record({ agent: 'claude', event: 'exit' }))

let totalCost = 0
const queued = []
let inputEnded = false
const mcpServers = (() => { try { return JSON.parse(option('--mcp-config') ?? '{}').mcpServers ?? {} } catch { return {} } })()
const controlWaiters = new Map()
/** A control request to the host (a permission prompt), answered by its `control_response`. */
const askHost = (request) => new Promise((resolve) => {
  const requestId = randomUUID()
  controlWaiters.set(requestId, resolve)
  send({ type: 'control_request', request_id: requestId, request })
})

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
  const endInterrupted = () => {
    send({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, terminal_reason: 'aborted_tools', session_id: sessionId, total_cost_usd: totalCost, permission_denials: [] })
    for (const message of messages) lifecycle(message.uuid, 'completed')
    turn = undefined
    return drain()
  }
  if (text().includes('#permit')) {
    const response = await askHost({ subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash',
      input: { command: 'git push --force', description: 'Publish the branch' }, description: 'Publish the branch',
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push --force' }],
        behavior: 'allow', destination: 'localSettings' }],
      decision_reason: 'This command requires approval', tool_use_id: 'toolu_permit' })
    record({ agent: 'claude', event: 'permission', response })
    if (response.behavior === 'deny' && response.interrupt) return endInterrupted()
  }
  if (text().includes('#question')) {
    const response = await askHost({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_question',
      input: { questions: [{ question: 'Which database?', header: 'Database', multiSelect: false,
        options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite', description: 'One file' }] }] },
      requires_user_interaction: true })
    record({ agent: 'claude', event: 'question', response })
    if (response.behavior === 'deny' && response.interrupt) return endInterrupted()
  }
  if (text().includes('#secret-tool')) {
    const permission = await askHost({ subtype: 'can_use_tool', tool_name: 'mcp__nessie_session__request_secret',
      input: SECRET_ARGS, tool_use_id: 'toolu_secret' })
    const server = mcpServers.nessie_session
    const result = permission.behavior === 'allow' && server ? await callSecretTool(server, SECRET_ARGS) : undefined
    record({ agent: 'claude', event: 'secret', permission: permission.behavior, result, server: Boolean(server) })
  }
  if (current.interrupted) return endInterrupted()
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
  if (message.type === 'control_response') {
    const requestId = message.response?.request_id
    controlWaiters.get(requestId)?.(message.response?.response ?? message.response ?? {})
    controlWaiters.delete(requestId)
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
}
