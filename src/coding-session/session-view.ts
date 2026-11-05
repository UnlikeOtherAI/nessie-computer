import { open } from 'node:fs/promises'
import { join } from 'node:path'
import headless from '@xterm/headless'

import {
  EXECUTOR_TERMINAL_COLS, EXECUTOR_TERMINAL_ROWS,
  ExecutorSessionScreenSchema, type ExecutorSessionScreen,
} from '@nessie/executor-protocol'

import { readJson, type CodingSessionPaths } from './session-files.js'
import type { CodingSessionMeta } from './types.js'

/** A bounded text observation for the model; only the viewer receives ANSI. */
export const sessionScreenText = async (screen: ExecutorSessionScreen | null): Promise<string> => {
  if (!screen) return 'No screen has been captured yet.'
  const terminal = new headless.Terminal({
    cols: screen.cols, rows: screen.rows, allowProposedApi: true, scrollback: 80,
  })
  try {
    await new Promise<void>((resolve) => terminal.write(screen.ansi, resolve))
    const buffer = terminal.buffer.active
    const lines = []
    for (let index = Math.max(0, buffer.length - screen.rows); index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
    }
    return lines.join('\n')
  } finally { terminal.dispose() }
}

/** The viewer never consumes the agent's delivered-events cursor. */
export const readSessionScreen = async (
  paths: CodingSessionPaths, meta: CodingSessionMeta,
): Promise<ExecutorSessionScreen | null> => {
  if (meta.agent === 'terminal') {
    const parsed = ExecutorSessionScreenSchema.safeParse(await readJson(join(paths.dir, 'terminal.json')))
    return parsed.success ? parsed.data : null
  }
  const file = await open(paths.events, 'r').catch(() => undefined)
  if (!file) return null
  try {
    const info = await file.stat()
    const start = Math.max(0, info.size - 128_000)
    const buffer = Buffer.alloc(Math.min(info.size, 128_000))
    await file.read(buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    lines.pop() // Partial last records are never rendered.
    const rendered = lines.flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        const content = event.text ?? event.summary ?? event.message ?? event.status ?? event.reason ?? ''
        const label = typeof event.name === 'string' ? `${event.kind}: ${event.name}` : event.kind
        return [`[${String(label)}] ${String(content)}`]
      } catch { return [] }
    })
    // Structured activity is plain text. Only a real PTY may author ANSI.
    const text = rendered.join('\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '')
    return {
      ansi: text.replaceAll('\n', '\r\n'), capturedAt: info.mtime.toISOString(), kind: 'activity',
      cols: EXECUTOR_TERMINAL_COLS, rows: EXECUTOR_TERMINAL_ROWS,
    }
  } finally { await file.close() }
}
