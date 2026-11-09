import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createSessionClaudeQuery } from '@nessie/t3-session-source/claude-sdk'

export function echoOwner({ beforeWrite, beforeStart, afterClearance, stderrBytes = 0, ...options } = {}) {
  const captures = [], writes = [], descriptors = [], children = [], parent = new AbortController()
  let terminationCount = 0
  const owner = {
    async start(descriptor, signal) {
      descriptors.push(descriptor)
      await beforeStart?.(signal)
      // This fixture intentionally runs the echo interface; production must use
      // the exact descriptor through its admitted native creator.
      const child = spawn(process.execPath, [fileURLToPath(new URL('./echo.mjs', import.meta.url))],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          env: { ...process.env, T3_SDK_FIXTURE_STDERR_BYTES: String(stderrBytes) } })
      children.push(child)
      let exited = false
      const closed = once(child, 'close').then(async () => { exited = true; await afterClearance?.() })
      let termination
      return {
        stdout: child.stdout, stderr: child.stderr, closed,
        get exitCode() { return child.exitCode },
        endInput: () => new Promise((resolve, reject) => {
          child.stdin.once('error', reject)
          child.stdin.end(resolve)
        }),
        terminate: () => termination ??= (async () => {
          terminationCount++
          if (!exited) child.kill()
          await closed
        })(),
      }
    },
    capture(encoded) {
      captures.push(encoded)
      const bytes = Buffer.from(encoded)
      let consumed = false
      return {
        async write(signal) {
          if (consumed) throw new Error('fixture replay')
          consumed = true
          await beforeWrite?.(encoded, signal)
          signal.throwIfAborted()
          const child = children[0]
          await new Promise((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve()))
          writes.push(encoded)
        },
        async discard() { bytes.fill(0) },
      }
    },
  }
  return { owner, options, captures, writes, descriptors, parent, children, terminations: () => terminationCount }
}

export function fixture(configuration) {
  const state = echoOwner(configuration)
  const handle = createSessionClaudeQuery({
    cwd: process.cwd(), env: { FIXTURE_ENV: 'original' },
    pathToClaudeCodeExecutable: process.execPath, ...state.options,
  }, state.owner, state.parent.signal)
  return { ...state, handle }
}

export const user = text => ({ type: 'user', session_id: '',
  message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null })
export const input = (...values) => {
  const messages = (async function* () { yield* values })()
  return { messages, interrupt: async () => { await messages.return() } }
}
export const deferred = () => Promise.withResolvers()
