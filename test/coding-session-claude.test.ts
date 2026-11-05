import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CLAUDE_APPENDED_SYSTEM_PROMPT,
  claudeArguments,
  claudeControlLine,
  claudeDenyLine,
  claudeUserLine,
  createClaudeStreamState,
} from '../src/coding-session/claude-adapter.js'
import type { CodingAgentConfig } from '../src/coding-session/config.js'
import { createPathRewriter } from '../src/coding-session/path-rewrite.js'
import { createProjector } from '../src/coding-session/projection.js'

/**
 * Claude Code's stream-json protocol, fed the event shapes claude 2.1.280
 * printed in the probe transcripts (one-shot, multi-turn, mid-turn follow-up,
 * interrupt, background task, `--permission-prompts none`).
 */

const windowsProjector = () => createProjector(createPathRewriter([
  { name: 'nessie', paths: ['C:\\Users\\ondre\\Projects\\Nessie'] },
  { name: undefined, paths: ['C:\\Users\\ondre'] },
], 'win32'))
const projector = windowsProjector()
const line = (value: unknown): string => JSON.stringify(value)
const lifecycle = (uuid: string, state: string) => line({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: 'x', session_id: 's' })
const result = (extra: Record<string, unknown> = {}) => line({
  type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'OK', total_cost_usd: 0.02, duration_ms: 5,
  permission_denials: [], session_id: 's', ...extra,
})

const agent: CodingAgentConfig = {
  command: ['C:/tools/claude.exe'], args: ['--effort', 'high'], permissionMode: 'acceptEdits',
  allowedTools: ['Bash(git *)', 'Bash(pnpm *)'], disallowedTools: ['WebFetch'], model: 'opus',
}

test('the argv is the verified stream-json invocation, with the reviewed power passed through', () => {
  const argv = claudeArguments(agent, { sessionId: 'uuid-1', resume: false, maxBudgetUsd: 20 })
  assert.deepEqual(argv, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
    '--session-id', 'uuid-1', '--permission-prompts', 'none', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(git *)', 'Bash(pnpm *)', '--disallowedTools', 'WebFetch', '--model', 'opus',
    '--max-budget-usd', '20', '--effort', 'high', '--append-system-prompt', CLAUDE_APPENDED_SYSTEM_PROMPT,
  ])
  const resumed = claudeArguments({ command: ['node', 'cli.js'], args: [], allowedTools: [], disallowedTools: [] }, {
    sessionId: 'uuid-1', resume: true,
  })
  assert.deepEqual(resumed.slice(0, 1), ['cli.js'])
  assert.ok(resumed.includes('--resume') && !resumed.includes('--session-id') && !resumed.includes('--permission-mode'))
  assert.match(CLAUDE_APPENDED_SYSTEM_PROMPT, /no person at this terminal/u)
  assert.match(CLAUDE_APPENDED_SYSTEM_PROMPT, /own git worktree/u)
})

test('stdin lines carry our uuid, and control requests are named ours', () => {
  assert.deepEqual(JSON.parse(claudeUserLine('u-1', 'hello')), {
    type: 'user', uuid: 'u-1', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    parent_tool_use_id: null, session_id: '',
  })
  assert.equal(JSON.parse(claudeControlLine('interrupt')).request.subtype, 'interrupt')
  assert.deepEqual(JSON.parse(claudeDenyLine('r-1', true)).response.response.behavior, 'deny')
  assert.equal(JSON.parse(claudeDenyLine('r-2', false)).response.subtype, 'error')
})

test('init keeps only model and permission mode; the initialize account only ever becomes a redaction', () => {
  const state = createClaudeStreamState(windowsProjector())
  const ready = state.accept(line({
    type: 'control_response',
    response: {
      subtype: 'success', request_id: 'nessie-initialize',
      response: { account: { email: 'person@example.com', organization: 'Person Example Org', subscriptionType: 'max' }, pid: 4 },
    },
  }))
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.events, [])
  // The model knows who is logged in and repeats it; claude 2.1.280 typed it into `git config` live.
  assert.deepEqual(state.accept(line({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'Committing as Person@Example.com for Person Example Org on the max plan.' },
      { type: 'tool_use', id: 't-1', name: 'Bash', input: { command: 'git config user.email "person@example.com"' } },
    ] },
  })).events, [
    { kind: 'assistant', text: 'Committing as <account> for <account> on the max plan.' },
    { kind: 'tool', name: 'Bash', summary: 'git config user.email "<account>"' },
  ])
  const init = line({
    type: 'system', subtype: 'init', cwd: 'C:\\Users\\ondre\\Projects\\Nessie', session_id: 's-1', model: 'claude-opus',
    permissionMode: 'acceptEdits', mcp_servers: [{ name: 'claude.ai Docs' }], memory_paths: { auto: 'C:\\Users\\ondre\\.claude' },
  })
  const first = state.accept(init)
  assert.equal(first.agentSessionId, 's-1')
  assert.deepEqual(first.events, [{ kind: 'system', subtype: 'init', model: 'claude-opus', permissionMode: 'acceptEdits' }])
  assert.deepEqual(state.accept(init).events, [], 'a repeated init with nothing new says nothing')
  for (const noise of [
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
    { type: 'stream_event', event: {} },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 },
    { type: 'system', subtype: 'status', status: 'requesting' },
  ]) assert.deepEqual(state.accept(line(noise)).events, [])
  assert.deepEqual(state.accept(line({ type: 'brand_new_event', secret: 'C:\\x' })).events, [
    { kind: 'system', subtype: 'unrecognized', message: 'brand_new_event' },
  ])
})

test('a turn ends on its result even when the completed lifecycle arrives after it', () => {
  const state = createClaudeStreamState(projector)
  state.noteSent('u-1')
  assert.equal(state.busy(), true)
  state.accept(lifecycle('u-1', 'queued'))
  state.accept(lifecycle('u-1', 'started'))
  state.accept(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Edited C:\\Users\\ondre\\Projects\\Nessie\\a.ts' }] } }))
  const ended = state.accept(result())
  assert.equal(ended.turnFinished?.text, 'OK')
  assert.equal(state.busy(), false)
  assert.equal(state.accept(lifecycle('u-1', 'completed')).turnFinished, undefined)
})

test('a follow-up folded into the running turn ends with that one result', () => {
  const state = createClaudeStreamState(projector)
  state.noteSent('u-1')
  state.accept(lifecycle('u-1', 'started'))
  state.noteSent('u-2')
  state.accept(lifecycle('u-2', 'queued'))
  assert.equal(state.accept(lifecycle('u-2', 'started')).turnFinished, undefined)
  const replay = state.accept(line({ type: 'user', isReplay: true, uuid: 'u-2', message: { role: 'user', content: 'also this' } }))
  assert.deepEqual(replay.events, [{ kind: 'user', text: 'also this' }])
  state.accept(lifecycle('u-2', 'completed'))
  assert.ok(state.accept(result()).turnFinished)
})

test('a message still queued when a result arrives keeps the session working until its own turn ends', () => {
  const state = createClaudeStreamState(projector)
  state.noteSent('u-1')
  state.accept(lifecycle('u-1', 'started'))
  state.noteSent('u-2')
  state.accept(lifecycle('u-2', 'queued'))
  assert.equal(state.accept(result()).turnFinished, undefined)
  assert.equal(state.busy(), true)
  state.accept(lifecycle('u-2', 'started'))
  assert.ok(state.accept(result({ total_cost_usd: 0.05 })).turnFinished)
})

test('background tasks are counted, never hold a turn open, and the turn one starts is reported', () => {
  const state = createClaudeStreamState(projector)
  state.noteSent('u-1')
  state.accept(lifecycle('u-1', 'started'))
  // A dev server started in the background runs for as long as the agent does.
  const started = state.accept(line({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1' }] }))
  assert.equal(started.backgroundTasks, 1)
  assert.ok(state.accept(result()).turnFinished, 'the result ends the turn with the task still running')
  assert.equal(state.busy(), false)
  assert.equal(state.backgroundTasks(), 1)
  const notice = state.accept(line({
    type: 'system', subtype: 'task_notification', output_file: 'C:\\Users\\ondre\\x.output', summary: 'Background command "sleep" completed',
  }))
  assert.deepEqual(notice.events, [{ kind: 'system', subtype: 'task', message: 'Background command "sleep" completed' }])
  assert.equal(state.accept(line({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })).backgroundTasks, 0)
  assert.equal(state.accept(line({ type: 'system', subtype: 'init', model: 'm', permissionMode: 'default' })).active, true)
  const unsolicited = state.accept(result({ origin: { kind: 'task-notification' }, total_cost_usd: 0.03 }))
  assert.equal(unsolicited.turnFinished?.origin, 'task-notification')
  assert.equal(unsolicited.turnFinished?.costUsd, 0.01, 'the CLI reports a running total; a turn costs its delta')
  assert.equal(state.processCostUsd(), 0.03)
})

test('an interrupt cancels the messages that had not started, except those it says are still queued', () => {
  const state = createClaudeStreamState(projector)
  state.noteSent('u-1')
  state.accept(lifecycle('u-1', 'started'))
  state.noteSent('u-2')
  state.accept(lifecycle('u-2', 'queued'))
  state.noteSent('u-3')
  const ack = state.accept(line({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'nessie-interrupt', response: { still_queued: [{ uuid: 'u-3' }] } },
  }))
  assert.deepEqual(ack.events, [{ kind: 'system', subtype: 'cancelled', message: '1 message(s) had not started and were cancelled by the interrupt.' }])
  assert.equal(state.accept(result({ subtype: 'error_during_execution', is_error: true })).turnFinished, undefined, 'u-3 is still to come')
  state.accept(lifecycle('u-3', 'started'))
  assert.ok(state.accept(result()).turnFinished)
  // A message the CLI dropped without a word no longer holds the interrupted turn open.
  const dropped = createClaudeStreamState(projector)
  dropped.noteSent('u-1')
  dropped.accept(lifecycle('u-1', 'started'))
  dropped.noteSent('u-9')
  dropped.accept(line({ type: 'control_response', response: { subtype: 'success', request_id: 'nessie-interrupt', response: {} } }))
  assert.ok(dropped.accept(result({ subtype: 'error_during_execution', is_error: true })).turnFinished)
  assert.equal(dropped.busy(), false)
})

test('tool calls, results, denials and test runs are projected; permission prompts are answered deny', () => {
  const state = createClaudeStreamState(projector)
  state.noteSent('u-1')
  // No lifecycle event this time: the echoed message alone shows the CLI took it.
  state.accept(line({ type: 'user', isReplay: true, uuid: 'u-1', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }))
  const call = state.accept(line({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }] },
  }))
  assert.deepEqual(call.events, [{ kind: 'tool', name: 'Bash', summary: 'pnpm test' }])
  const output = state.accept(line({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Exit code 1\nC:\\Users\\ondre\\Projects\\Nessie\\a.test.ts failed', is_error: true }] },
  }))
  assert.deepEqual(output.events, [{ kind: 'tool_result', name: 'Bash', summary: 'Exit code 1 <nessie>/a.test.ts failed', isError: true }])
  assert.deepEqual(output.test, { command: 'pnpm test', exitCode: 1 })
  const prompt = state.accept(line({
    type: 'control_request', request_id: 'r-9', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'C:\\x' } },
  }))
  assert.deepEqual(prompt.answerControlRequest, { requestId: 'r-9', supported: true })
  assert.deepEqual(prompt.events, [{ kind: 'system', subtype: 'permission_denied', tool: 'Write' }])
  const final = state.accept(result({
    permission_denials: [{ tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'git push --force' } }],
  }))
  assert.deepEqual(final.turnFinished?.permissionDenials, [{ tool: 'Bash', summary: 'git push --force' }])
})

test('an interrupt is acknowledged and its turn ends in the CLI\'s error result', () => {
  const state = createClaudeStreamState(projector)
  state.noteSent('u-1')
  state.accept(lifecycle('u-1', 'started'))
  assert.equal(state.accept(line({
    type: 'control_response', response: { subtype: 'success', request_id: 'nessie-interrupt', response: { still_queued: [] } },
  })).interruptAcknowledged, true)
  const ended = state.accept(result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', result: undefined }))
  assert.equal(ended.turnFinished?.subtype, 'error_during_execution')
  assert.equal(ended.turnFinished?.isError, true)
  assert.equal(ended.turnFinished?.text, '')
})
