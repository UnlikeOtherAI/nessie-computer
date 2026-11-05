import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { AgentDriver, AgentDriverContext } from '../src/coding-session/agent-process.js'
import { codexArguments, createCodexTurnState } from '../src/coding-session/codex-adapter.js'
import { createCodexDriver } from '../src/coding-session/codex-driver.js'
import { createPathRewriter } from '../src/coding-session/path-rewrite.js'
import { createCodingProcessControl } from '../src/coding-session/process-control.js'
import { createProjector } from '../src/coding-session/projection.js'
import { codingSessionPaths } from '../src/coding-session/session-files.js'
import { initialCodingSessionState, type CodingSessionState } from '../src/coding-session/types.js'
import { SCRIPTED_AGENT, waitUntil } from './coding-session-harness.js'

/**
 * Codex's `exec --json` protocol. The failure transcript is the one
 * codex-cli 0.155.1 printed on this machine with its ChatGPT quota spent;
 * the item shapes are those in its binary.
 */
const projector = createProjector(createPathRewriter([{ name: 'work', paths: ['/home/ondre/work'] }], 'linux'))
const line = (value: unknown): string => JSON.stringify(value)

test('a first turn and a resumed turn put the reviewed args where exec itself parses them', () => {
  const agent = {
    command: ['node', '/opt/codex/bin/codex.js'], args: ['--dangerously-bypass-approvals-and-sandbox'],
    allowedTools: [], disallowedTools: [], model: 'gpt-5.5',
  }
  assert.deepEqual(codexArguments(agent, { folder: '/home/ondre/work' }), [
    '/opt/codex/bin/codex.js', 'exec', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.5',
    '-C', '/home/ondre/work', '--json', '-',
  ])
  // 0.155.1 refuses `exec resume … --sandbox`, so options must precede `resume`.
  assert.deepEqual(codexArguments(agent, { folder: '/home/ondre/work', threadId: 'th-1' }), [
    '/opt/codex/bin/codex.js', 'exec', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.5',
    '-C', '/home/ondre/work', 'resume', 'th-1', '--json', '-',
  ])
})

test('the captured usage-limit failure becomes an error result, not a silent success', () => {
  const turn = createCodexTurnState(projector)
  const message = 'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits '
    + 'or try again at Sep 26th, 2026 4:33 PM.'
  assert.equal(turn.accept(line({ type: 'thread.started', thread_id: '01a0cb41-1d6e-7391-b2b6-d418d682d931' })).threadId,
    '01a0cb41-1d6e-7391-b2b6-d418d682d931')
  assert.deepEqual(turn.accept(line({ type: 'turn.started' })).events, [])
  assert.deepEqual(turn.accept(line({ type: 'error', message })).events, [{ kind: 'system', subtype: 'error', message }])
  assert.equal(turn.accept(line({ type: 'turn.failed', error: { message } })).turnEnded, true)
  const result = turn.finish({ code: 1, interrupted: false })
  assert.equal(result.isError, true)
  assert.equal(result.subtype, 'error')
  assert.equal(result.text, message)
})

test('items become tool, tool_result and assistant events; unknown events are kept by type only', () => {
  const turn = createCodexTurnState(projector)
  assert.deepEqual(turn.accept(line({
    type: 'item.started', item: { id: 'i0', type: 'command_execution', command: 'pnpm test in /home/ondre/work', status: 'in_progress' },
  })).events, [{ kind: 'tool', name: 'shell', summary: 'pnpm test in <work>' }])
  const done = turn.accept(line({
    type: 'item.completed',
    item: { id: 'i0', type: 'command_execution', command: 'pnpm test', aggregated_output: '1 failed', exit_code: 1, status: 'failed' },
  }))
  assert.deepEqual(done.events, [{ kind: 'tool_result', name: 'shell', summary: '1 failed', isError: true, exitCode: 1 }])
  assert.deepEqual(done.test, { command: 'pnpm test', exitCode: 1 })
  assert.deepEqual(turn.accept(line({
    type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: '/home/ondre/work/a.ts', kind: 'update' }] },
  })).events, [{ kind: 'tool', name: 'edit', summary: 'update <work>/a.ts' }])
  assert.deepEqual(turn.accept(line({ type: 'item.completed', item: { id: 'i2', type: 'reasoning', text: 'private' } })).events, [])
  assert.deepEqual(turn.accept(line({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'All done.' } })).events, [
    { kind: 'assistant', text: 'All done.' },
  ])
  assert.deepEqual(turn.accept(line({ type: 'session.configured', model: 'x', cwd: '/home/ondre' })).events, [
    { kind: 'system', subtype: 'unrecognized', message: 'session.configured' },
  ])
  assert.equal(turn.accept(line({ type: 'turn.completed', usage: { input_tokens: 1 } })).turnEnded, true)
  const result = turn.finish({ code: 0, interrupted: false })
  assert.deepEqual([result.isError, result.subtype, result.text], [false, 'success', 'All done.'])
})

test('a command or an edit Codex declined is a permission denial on the result', () => {
  const turn = createCodexTurnState(projector)
  const declined = turn.accept(line({
    type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'git push --force', status: 'declined' },
  }))
  assert.deepEqual(declined.events, [{ kind: 'system', subtype: 'permission_denied', tool: 'shell' }])
  turn.accept(line({
    type: 'item.completed', item: { id: 'i1', type: 'file_change', status: 'declined', changes: [{ path: '/etc/hosts', kind: 'update' }] },
  }))
  turn.accept(line({ type: 'turn.completed' }))
  assert.deepEqual(turn.finish({ code: 0, interrupted: false }).permissionDenials, [
    { tool: 'shell', summary: 'git push --force' }, { tool: 'edit', summary: 'update <host path>' },
  ])
})

test('a process that exits without ending its turn, or is killed, says which', () => {
  assert.equal(createCodexTurnState(projector).finish({ code: 1, interrupted: false }).subtype, 'agent_exited')
  assert.equal(createCodexTurnState(projector).finish({ code: null, interrupted: true }).subtype, 'interrupted')
})

const SESSION = '0f0e0d0c-0b0a-4908-8706-050403020100'

test('a message sent while one turn exits and the next is starting waits its turn: one codex at a time', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-codex-driver-'))
  try {
    const paths = codingSessionPaths(dir, SESSION)
    await mkdir(paths.dir, { recursive: true })
    const state: CodingSessionState = { ...initialCodingSessionState(new Date().toISOString()), status: 'starting' }
    let driver: AgentDriver | undefined
    let probed = false
    const observed: { running: boolean; busy: boolean }[] = []
    const context: AgentDriverContext = {
      agent: { command: [process.execPath, SCRIPTED_AGENT], args: [], allowedTools: [], disallowedTools: [] },
      control: createCodingProcessControl(process.platform, {}),
      env: { ...process.env, NESSIE_SCRIPTED_RECORD_DIR: dir },
      folder: dir, paths, projector,
      // Slow, so the gap between one turn's exit and the next turn's spawn is wide.
      stillOwner: () => new Promise((settle) => { setTimeout(() => settle(true), 300) }),
      emit: () => undefined,
      update: (patch) => {
        Object.assign(state, patch)
        // The exit handler clears the queue and starts the next turn in one go. Right after that,
        // in the very gap the race lived in, the driver must not look idle and a send must queue.
        if (patch.queued === 0 && patch.status === undefined && driver && !probed) {
          probed = true
          queueMicrotask(() => {
            observed.push({ running: driver!.running(), busy: driver!.busy() })
            void driver!.send('third', 'u-3')
          })
        }
      },
      state: () => state,
      log: () => undefined,
    }
    driver = createCodexDriver(context)
    await driver.send('#sleep=800 first', 'u-1')
    await driver.send('second', 'u-2')
    await waitUntil(async () => (state.turn === 3 && state.status === 'waiting_for_input' ? true : undefined), 40_000, 'three turns')
    assert.deepEqual(observed, [{ running: true, busy: true }])
    const lines = (await readFile(join(dir, 'agents.jsonl'), 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; pid: number })
    let live = 0
    for (const entry of lines) {
      live += entry.event === 'start' ? 1 : -1
      assert.ok(live <= 1, 'two codex processes never run at once')
    }
    assert.equal(lines.filter((entry) => entry.event === 'start').length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
