import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EXECUTOR_TERMINAL_COLS as COLS, EXECUTOR_TERMINAL_ROWS as ROWS } from '@nessie/executor-protocol'

import {
  deadPaneExitCode,
  PANE_EXIT_STATUS_WAIT_MS,
  paneCursor,
  terminalProcessArguments,
} from '../src/coding-session/terminal-process.js'
import { createCodingHarness, OWNER_B, waitUntil } from './coding-session-harness.js'

test('the PTY launcher passes configured arguments literally after tmux end-of-options', () => {
  const args = terminalProcessArguments(['/bin/echo', "a'; touch /tmp/nope; '"])
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['/usr/bin/env', '--', '/bin/echo', "a'; touch /tmp/nope; '"])
})

test('a dead pane ends the session only once tmux knows how its program ended', () => {
  const pane = (dead: string, status = '', signal = '') => ({ dead, status, signal })
  assert.equal(deadPaneExitCode(pane('0'), 0), undefined)
  // Its terminal has closed and tmux has not reaped it yet: that is no exit status, least of all 0.
  assert.equal(deadPaneExitCode(pane('1'), PANE_EXIT_STATUS_WAIT_MS - 1), undefined)
  assert.equal(deadPaneExitCode(pane('1', '3'), 0), 3)
  assert.equal(deadPaneExitCode(pane('1', '0'), 0), 0)
  assert.equal(deadPaneExitCode(pane('1', '', '9'), 0), 1)
  assert.equal(deadPaneExitCode(pane('1'), PANE_EXIT_STATUS_WAIT_MS), 1)
})

test('a cursor tmux holds past a full line is drawn in the last column', () => {
  assert.deepEqual(paneCursor(0, 0), { row: 1, column: 1 })
  assert.deepEqual(paneCursor(COLS - 1, ROWS - 1), { row: ROWS, column: COLS })
  // After a character in the last column tmux reports cursor_x = COLS until the next one wraps.
  assert.deepEqual(paneCursor(COLS, 3), { row: 4, column: COLS })
  for (const [x, y] of [[COLS + 1, 0], [0, ROWS], [-1, 0], [0, -1], [Number.NaN, 0], [1.5, 0]] as const) {
    assert.equal(paneCursor(x, y), undefined, `${x}:${y}`)
  }
})

const terminalHarness = (codingSessions: Record<string, unknown> = {}) => createCodingHarness({
  codingSessions,
  agentEnv: { inheritUserSession: false, set: {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
  } },
})

test('a terminal starts only what the command rules permit, in an existing folder, and only through the daemon', {
  timeout: 60_000,
}, async () => {
  const harness = await terminalHarness()
  try {
    type Options = Parameters<typeof harness.call>[2]
    const refused = async (args: Record<string, unknown>, options: Options, code: string) => {
      const answer = await harness.call('session_start', { agent: 'terminal', ...args }, options)
      assert.equal(answer.ok, false, JSON.stringify(answer.body))
      assert.equal(answer.body.code, code, JSON.stringify(answer.body))
    }
    const allowlist = { mode: 'allowlist', allowlist: ['git status *'], denylist: [] }
    await refused({ command: ['git', 'push'] }, { commandRules: allowlist }, 'coding_session_command_refused')
    await refused({ command: ['/usr/bin/git', 'status'] }, { commandRules: allowlist }, 'coding_session_command_refused')
    await refused({ command: ['git', 'push'] }, { commandRules: { mode: 'all', allowlist: [], denylist: ['git push *'] } },
      'coding_session_command_refused')
    await refused({ command: ['git', 'status'] }, { commandRules: null }, 'coding_session_command_rules_missing')
    await refused({ command: ['git', 'status'], cwd: join(harness.dir, 'missing') }, {}, 'coding_session_cwd_unavailable')
    await refused({ command: ['git', 'status'], cwd: 'relative' }, {}, 'coding_session_invalid_arguments')
    await refused({ command: [] }, {}, 'coding_session_invalid_arguments')
    await refused({ command: ['git'], root: 'work', prompt: '' }, {}, 'coding_session_invalid_arguments')
    const listed = await harness.call('session_list', {})
    assert.deepEqual(listed.body.agents, ['claude', 'codex', 'terminal'])
    assert.deepEqual(listed.body.sessions, [], 'no refused start left a session behind')
  } finally {
    await harness.cleanup()
  }
})

test('two real PTYs stay isolated, survive a bridge restart, render ANSI and close independently', {
  timeout: 120_000,
}, async () => {
  const programDir = process.platform === 'win32' ? undefined : await mkdtemp(join(tmpdir(), 'nessie-terminal-argv-'))
  const program = programDir ? join(programDir, 'shell with spaces') : 'C:\\Windows\\System32\\cmd.exe'
  if (programDir) await symlink('/bin/sh', program)
  const harness = await terminalHarness()
  try {
    const start = async (title: string) => {
      const answer = await harness.call('session_start', { agent: 'terminal', command: [program], cwd: harness.root, title })
      assert.equal(answer.ok, true, JSON.stringify(answer.body))
      return String(answer.body.sessionId)
    }
    const first = await start('First terminal')
    const second = await start('Second terminal')
    assert.notEqual(first, second)
    // Every wait below says, when it runs out, what the session's own files say.
    const dump = async (sessionId: string) => {
      for (const file of ['session.json', 'host.log', 'agent-stderr.log', 'terminal.json']) {
        console.error(file, await readFile(join(harness.stateDir, 'sessions', sessionId, file), 'utf8').catch(() => 'unavailable'))
      }
    }
    const reaches = async (sessionId: string, status: string) => {
      try { return await harness.waitForStatus(sessionId, (body) => body.status === status) }
      catch (error) {
        await dump(sessionId)
        throw error
      }
    }
    await reaches(first, 'working')
    await reaches(second, 'working')
    // A PTY exists before its shell finishes terminal initialization, which may flush input.
    for (const sessionId of [first, second]) await waitUntil(async () => {
      const captured = await readFile(join(harness.stateDir, 'sessions', sessionId, 'terminal.json'), 'utf8').catch(() => '')
      if (!captured) return undefined
      const answer = await harness.call('terminal_read', { sessionId })
      return typeof answer.body.text === 'string' && answer.body.text.trim().length > 0 ? true : undefined
    }, 30_000, 'initial shell screen')
    const write = async (sessionId: string, message: string) => {
      const answer = await harness.call('session_send', { sessionId, message, terminal: true })
      assert.equal(answer.ok, true, JSON.stringify(answer.body))
    }
    await write(first, process.platform === 'win32' ? 'echo FIRST_SESSION_ONLY\r' : "printf '\\033[2J\\033[HFIRST_SESSION_ONLY\\n'\r")
    await write(second, process.platform === 'win32' ? 'echo SECOND_SESSION_ONLY\r' : "printf '\\033[2J\\033[HSECOND_SESSION_ONLY\\n'\r")
    const readContaining = async (sessionId: string, marker: string) => {
      let last: unknown
      try {
        return await waitUntil(async () => {
          const answer = await harness.call('terminal_read', { sessionId })
          last = answer.body
          return typeof answer.body.text === 'string' && answer.body.text.includes(marker) ? answer.body.text : undefined
        }, 30_000, marker)
      } catch (error) {
        console.error('Last test-shell screen', last)
        await dump(sessionId)
        throw error
      }
    }
    assert.doesNotMatch(await readContaining(first, 'FIRST_SESSION_ONLY'), /SECOND_SESSION_ONLY/)
    assert.doesNotMatch(await readContaining(second, 'SECOND_SESSION_ONLY'), /FIRST_SESSION_ONLY/)
    assert.equal((await harness.call('terminal_read', { sessionId: first }, { owner: OWNER_B })).ok, false)
    await harness.restartBridge()
    await write(first, 'echo AFTER_RECONNECT\r')
    await readContaining(first, 'AFTER_RECONNECT')
    assert.equal((await harness.call('session_close', { sessionId: first })).ok, true)
    await reaches(first, 'closed')
    await write(second, 'echo STILL_ALIVE\r')
    await readContaining(second, 'STILL_ALIVE')
    await write(second, 'exit 3\r')
    const ended = await reaches(second, 'failed')
    const read = await harness.call('terminal_read', { sessionId: second })
    assert.equal(read.body.exitCode, 3, JSON.stringify(read.body))
    assert.equal(ended.reason, 'terminal_process_ended')
  } finally {
    await harness.cleanup()
    if (programDir) await rm(programDir, { recursive: true, force: true })
  }
})

test('a terminal has no turn: the turn limit and an interrupt never end it', { timeout: 90_000 }, async () => {
  // 1.2 seconds, which would end a coding agent's turn many times over while this runs.
  const harness = await terminalHarness({ maxTurnMinutes: 0.02 })
  try {
    const shell = process.platform === 'win32' ? ['C:\\Windows\\System32\\cmd.exe'] : ['/bin/sh']
    const started = await harness.call('session_start', { agent: 'terminal', command: shell, cwd: harness.root })
    assert.equal(started.ok, true, JSON.stringify(started.body))
    const sessionId = String(started.body.sessionId)
    await harness.waitForStatus(sessionId, (body) => body.status === 'working')
    const echo = async (marker: string) => {
      assert.equal((await harness.call('session_send', { sessionId, message: `echo ${marker}\r`, terminal: true })).ok, true)
      await waitUntil(async () => {
        const read = await harness.call('terminal_read', { sessionId })
        return typeof read.body.text === 'string' && read.body.text.includes(marker) ? true : undefined
      }, 30_000, marker)
    }
    await echo('BEFORE_LIMIT')
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    await echo('AFTER_LIMIT')
    assert.equal((await harness.call('session_interrupt', { sessionId })).ok, true)
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    await echo('AFTER_INTERRUPT')
    const read = await harness.call('terminal_read', { sessionId })
    assert.equal(read.body.status, 'working', JSON.stringify(read.body))
  } finally {
    await harness.cleanup()
  }
})

test('a retried start answers with the session it started, even after the rules tightened', { timeout: 60_000 }, async () => {
  const harness = await terminalHarness()
  try {
    const shell = process.platform === 'win32' ? ['C:\\Windows\\System32\\cmd.exe'] : ['/bin/sh']
    const command = '3f0f4a4e-8c1f-4c83-9d2c-5b1f3f0e7a11'
    const first = await harness.call('session_start', { agent: 'terminal', command: shell, cwd: harness.root }, { command })
    assert.equal(first.ok, true, JSON.stringify(first.body))
    const retried = await harness.call('session_start', { agent: 'terminal', command: shell, cwd: harness.root }, {
      command, commandRules: { mode: 'allowlist', allowlist: ['git status *'], denylist: [] },
    })
    assert.equal(retried.ok, true, JSON.stringify(retried.body))
    assert.equal(retried.body.sessionId, first.body.sessionId)
    assert.equal(retried.body.replayed, true)
    assert.equal((await harness.call('session_close', { sessionId: String(first.body.sessionId) })).ok, true)
  } finally {
    await harness.cleanup()
  }
})

test('a program that fills a whole line keeps running and ends as it chooses', {
  // ConPTY's screen is xterm's own serialization; only tmux reports a cursor past the last column.
  skip: process.platform === 'win32',
  timeout: 60_000,
}, async () => {
  const harness = await terminalHarness()
  try {
    // A full line of zeros leaves the cursor past the last column; the program then waits for Enter.
    const started = await harness.call('session_start', {
      agent: 'terminal', command: ['/bin/sh', '-c', `printf %0${COLS}d 0; read line; exit 5`], cwd: harness.root,
    })
    assert.equal(started.ok, true, JSON.stringify(started.body))
    const sessionId = String(started.body.sessionId)
    const line = '0'.repeat(COLS)
    const shown = await waitUntil(async () => {
      const read = await harness.call('terminal_read', { sessionId })
      const ended = ['failed', 'closed', 'interrupted'].includes(String(read.body.status))
      return ended || String(read.body.text).includes(line) ? read.body : undefined
    }, 30_000, 'the full line, or the session ending')
    assert.equal(shown.status, 'working', JSON.stringify(shown))
    assert.equal((await harness.call('session_send', { sessionId, message: '\r', terminal: true })).ok, true)
    await harness.waitForStatus(sessionId, (body) => body.status === 'failed')
    const read = await harness.call('terminal_read', { sessionId })
    assert.equal(read.body.exitCode, 5, JSON.stringify(read.body))
  } finally {
    await harness.cleanup()
  }
})
