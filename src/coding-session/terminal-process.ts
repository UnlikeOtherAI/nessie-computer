import { readTerminalEffectFrame, terminalProgramEnvironment } from './terminal-effect-frame.js'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

import {
  EXECUTOR_TERMINAL_COLS as COLS,
  EXECUTOR_TERMINAL_ROWS as ROWS,
  EXECUTOR_TERMINAL_SCROLLBACK as HISTORY,
  type ExecutorSessionScreen,
} from '@nessie/executor-protocol'

import { resolveProgramPath } from './program-path.js'

const run = promisify(execFile)
const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

/** env keeps even a lone executable in tmux's direct-argv mode, never `sh -c`. */
export const terminalProcessArguments = (argv: readonly string[]): string[] => [
  'new-session', '-d', '-s', 'nessie', '-x', String(COLS), '-y', String(ROWS), '--', '/usr/bin/env', '--', ...argv,
]

/** Only a tmux before 3.3, whose program a signal ended, leaves a dead pane silent for this long. */
export const PANE_EXIT_STATUS_WAIT_MS = 5_000

/**
 * The exit code a dead pane ends the session with, or `undefined` while it
 * lives or tmux does not yet know how its program ended. tmux marks a pane
 * dead the moment its terminal closes and records the ending only once it has
 * reaped the program, on its SIGCHLD — and before 3.6 it can lose that signal
 * outright (see the loop), so an empty status is never an exit 0. A signal
 * leaves no exit status, so it ends the session with 1, as a Windows terminal
 * does; tmux before 3.3 cannot name the signal, so there a pane dead and
 * silent for `PANE_EXIT_STATUS_WAIT_MS` counts as one.
 */
export const deadPaneExitCode = (
  pane: { dead: string; status: string; signal: string }, deadForMs: number,
): number | undefined => {
  if (pane.dead !== '1') return undefined
  if (/^\d+$/u.test(pane.status)) return Number(pane.status)
  return pane.signal || deadForMs >= PANE_EXIT_STATUS_WAIT_MS ? 1 : undefined
}

/**
 * The 1-based row and column to draw tmux's `cursor_x`/`cursor_y` at, or
 * `undefined` when they are not on this pane's screen. After a character in
 * the last column tmux holds the cursor one past it, at `cursor_x` = COLS,
 * until the next character wraps; a terminal shows that cursor in the last
 * column, and so does this. Refusing it ended a session whose program had
 * only filled a line.
 */
export const paneCursor = (x: number, y: number): { row: number; column: number } | undefined => {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > COLS || y < 0 || y >= ROWS) return undefined
  return { row: y + 1, column: Math.min(x, COLS - 1) + 1 }
}

/**
 * A dedicated foreground tmux server under the existing containment guard.
 * Its socket is owner-only and separate from the person's own tmux server.
 * Local attachment: tmux -S <socket> attach -t nessie.
 */
export const runTerminalProcess = async (): Promise<void> => {
  // The marker belongs to this executor helper, never the user's program.
  // The program environment is stripped separately; this helper still needs its ACL identity.
  if (process.platform === 'win32') {
    const { runWindowsTerminal } = await import('./terminal-windows.js')
    return runWindowsTerminal()
  }
  const lines = createInterface({ input: process.stdin })
  const iterator = lines[Symbol.asyncIterator]()
  const first = await iterator.next()
  const required = process.env.NESSIE_SESSION_EFFECT_REQUIRED === '1'
  const launch = readTerminalEffectFrame(first.done ? undefined : JSON.parse(first.value), required)
  const argv = launch.value
  if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('terminal_invalid_program')
  }
  const tmux = await resolveProgramPath('tmux', process.env)
  if (!tmux) throw new Error('terminal_tmux_missing')
  const socketDir = await mkdtemp(join(tmpdir(), 'nessie-tmux-'))
  const socket = join(socketDir, 's')
  const env = { ...terminalProgramEnvironment(), TERM: 'xterm-256color', TMUX: '' }
  await launch.effect?.consume()
  launch.effect?.assertLive()
  const server = spawn(tmux, ['-D', '-S', socket, '-f', '/dev/null'], { env, stdio: 'ignore' })
  let serverEnded = false
  server.once('exit', () => { serverEnded = true })
  server.once('error', () => { serverEnded = true })
  // A client must never auto-start a competing server while our foreground server binds.
  const command = (...args: string[]) => run(tmux, ['-N', '-S', socket, ...args], {
    env, timeout: 5_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
  })
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await launch.effect?.consume()
        launch.effect?.assertLive()
        await command('set-option', '-g', 'remain-on-exit', 'on', ';',
          'set-option', '-g', 'history-limit', String(HISTORY), ';', ...terminalProcessArguments(argv))
        break
      }
      catch {
        if (serverEnded || attempt >= 30) throw new Error('terminal_tmux_start_failed')
        await delay(100)
      }
    }
    await command('set-window-option', '-t', 'nessie:0', 'window-size', 'manual')
    await command('resize-window', '-t', 'nessie:0', '-x', String(COLS), '-y', String(ROWS))
    process.stdout.write(JSON.stringify({ socketPath: socket }) + '\n')
    let inputEnded = false
    void (async () => {
      for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
        const frame = readTerminalEffectFrame(JSON.parse(line), required)
        const data = frame.value
        if (typeof data !== 'string' || data.length > 32_000) throw new Error('terminal_invalid_input')
        const bytes = Buffer.from(data, 'utf8')
        for (let offset = 0; offset < bytes.length; offset += 512) {
          await frame.effect?.consume()
          frame.effect?.assertLive()
          await command('send-keys', '-t', 'nessie:0.0', '-H',
            ...[...bytes.subarray(offset, offset + 512)].map((byte) => byte.toString(16).padStart(2, '0')))
        }
      }
      inputEnded = true
    })().catch(() => { inputEnded = true })
    let previous = ''
    let deadSince: number | undefined
    while (!inputEnded && !serverEnded) {
      const capture = await command('capture-pane', '-p', '-e', '-S', '-' + HISTORY, '-t', 'nessie:0.0', ';',
        'display-message', '-p', '-t', 'nessie:0.0',
        'NESSIE:#{cursor_x}:#{cursor_y}:#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}')
      const parts = capture.stdout.trimEnd().split('\n')
      const cursor = parts.pop()?.split(':')
      if (!cursor || cursor[0] !== 'NESSIE') throw new Error('terminal_capture_failed')
      const at = paneCursor(Number(cursor[1]), Number(cursor[2]))
      if (!at) throw new Error('terminal_capture_failed')
      while (parts.join('\n').length > 240_000 && parts.length > ROWS) parts.shift()
      const ansi = parts.join('\r\n') + '\u001b[' + at.row + ';' + at.column + 'H'
      if (ansi !== previous) {
        previous = ansi
        const screen: ExecutorSessionScreen = {
          ansi, capturedAt: new Date().toISOString(), cols: COLS, rows: ROWS, kind: 'terminal',
        }
        process.stdout.write(JSON.stringify(screen) + '\n')
      }
      if (cursor[3] === '1') deadSince ??= Date.now()
      const exitCode = deadPaneExitCode(
        { dead: cursor[3] ?? '', status: cursor[4] ?? '', signal: cursor[5] ?? '' }, Date.now() - (deadSince ?? Date.now()),
      )
      if (exitCode !== undefined) { process.exitCode = exitCode; break }
      // Dead and not yet reaped. tmux before 3.6 records the pane in utmp through
      // libutempter as its terminal closes, which sets SIGCHLD to SIG_DFL while its
      // helper runs; the program's own SIGCHLD landing then is discarded, and tmux
      // would never reap it. So ask again, as tmux 3.6 does itself (tmux fa5f3cef).
      if (deadSince !== undefined) server.kill('SIGCHLD')
      await delay(200)
    }
  } finally {
    await command('kill-server').catch(() => undefined)
    if (!serverEnded) server.kill('SIGTERM')
    await rmdir(socketDir).catch(() => undefined)
    lines.close()
    process.stdin.destroy()
  }
}
