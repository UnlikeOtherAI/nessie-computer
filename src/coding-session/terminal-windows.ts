import { readTerminalEffectFrame, terminalProgramEnvironment } from './terminal-effect-frame.js'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import headless from '@xterm/headless'
import serialize from '@xterm/addon-serialize'
import { EXECUTOR_TERMINAL_COLS, EXECUTOR_TERMINAL_ROWS, EXECUTOR_TERMINAL_SCROLLBACK } from '@nessie/executor-protocol'

/** ConPTY stays in the detached session host, inside its existing Windows Job. */
export const runWindowsTerminal = async (): Promise<void> => {
  const lines = createInterface({ input: process.stdin })
  const iterator = lines[Symbol.asyncIterator]()
  const first = await iterator.next()
  const required = process.env.NESSIE_SESSION_EFFECT_REQUIRED === '1'
  const launch = readTerminalEffectFrame(first.done ? undefined : JSON.parse(first.value), required)
  const argv = launch.value
  if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('terminal_invalid_command')
  }
  const term = new headless.Terminal({
    cols: EXECUTOR_TERMINAL_COLS, rows: EXECUTOR_TERMINAL_ROWS,
    scrollback: EXECUTOR_TERMINAL_SCROLLBACK, allowProposedApi: true,
  })
  const serializer = new serialize.SerializeAddon()
  term.loadAddon(serializer)
  await launch.effect?.consume()
  launch.effect?.assertLive()
  const child = spawn(argv[0] as string, argv.slice(1) as string[], {
    cwd: process.cwd(), env: terminalProgramEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
  })
  child.stdout.setEncoding('utf8')
  term.onData((data) => { child.stdin.write(data) })
  let dirty = true
  let pendingWrites = 0
  const flush = () => {
    if (!dirty || pendingWrites) return
    dirty = false
    // Reduce complete scrollback lines until the bounded screen fits the relay.
    let history = EXECUTOR_TERMINAL_SCROLLBACK
    let ansi = serializer.serialize({ scrollback: history })
    while (ansi.length > 256_000 && history > 0) {
      history = Math.max(0, history - 50)
      ansi = serializer.serialize({ scrollback: history })
    }
    process.stdout.write(JSON.stringify({
      ansi, cols: EXECUTOR_TERMINAL_COLS, rows: EXECUTOR_TERMINAL_ROWS,
      capturedAt: new Date().toISOString(), kind: 'terminal',
    }) + '\n')
  }
  child.stdout.on('data', (data: string) => {
    pendingWrites += 1
    term.write(data, () => { pendingWrites -= 1; dirty = true })
  })
  const timer = setInterval(flush, 200)
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (exitCode) => {
      term.write('', () => { flush(); process.exitCode = exitCode ?? 1; resolve() })
    })
  })
  void (async () => {
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      const frame = readTerminalEffectFrame(JSON.parse(line), required)
      const data = frame.value
      if (typeof data !== 'string' || data.length > 32_000) throw new Error('terminal_invalid_input')
      await frame.effect?.consume()
      frame.effect?.assertLive()
      child.stdin.write(data)
    }
    child.stdin.end()
  })().catch(() => { child.stdin.end() })
  await exited
  clearInterval(timer)
  term.dispose()
  lines.close()
  process.stdin.destroy()
}
