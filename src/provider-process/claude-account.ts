import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

/** Read-only SDK control protocol: no user message is written, so no inference turn starts. */
export const probeClaudeAccount = async (program: string, env: NodeJS.ProcessEnv): Promise<{
  initialization: unknown; usage: unknown
}> => {
  const child = spawn(program, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--no-session-persistence', '--permission-prompts', 'none', '--setting-sources', 'user'],
  { env, cwd: homedir(), windowsHide: true, stdio: 'pipe' })
  child.stderr.resume()
  let serial = 0
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const fail = (): void => {
    for (const item of pending.values()) item.reject(new Error('Claude account probe ended.'))
    pending.clear()
  }
  child.once('error', fail)
  child.once('exit', fail)
  let bytes = 0
  child.stdout.on('data', (data: Buffer) => {
    bytes += data.length
    if (bytes > 1024 * 1024) { fail(); child.kill() }
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    bytes = 0
    if (line.length > 1024 * 1024) return
    try {
      const value = JSON.parse(line) as { type?: string; response?: {
        request_id?: string; subtype?: string; response?: unknown
      } }
      if (value.type !== 'control_response' || !value.response?.request_id) return
      const item = pending.get(value.response.request_id)
      if (!item) return
      pending.delete(value.response.request_id)
      if (value.response.subtype === 'success') item.resolve(value.response.response)
      else item.reject(new Error('Claude account operation is unavailable.'))
    } catch { /* Only bounded control responses are read. */ }
  })
  const request = (subtype: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = `nessie-account-${++serial}`
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Claude account probe timed out.')) }, 10_000)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id,
        request: { subtype, ...params } })}\n`, (error) => { if (error) fail() })
    })
  try {
    const initialization = await request('initialize')
    const usage = await request('get_usage', { skip_behaviors: true }).catch(() => null)
    return { initialization, usage }
  } finally {
    lines.close()
    child.stdin.end()
    child.kill()
    fail()
  }
}
