/**
 * Stands in for the executor daemon inside a systemd user unit, for the
 * restart suite. Its first life starts a real coding-sessions bridge the way
 * the daemon does (the supervisor marker included), starts a session whose
 * turn is held until the suite releases it, writes the session id to <out>
 * and then idles like `serve`. A later life — the unit restarted — finds
 * <out> and only idles.
 *
 *   node --import tsx stand-in-executor.ts <config> <out.json>
 */
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createExecutorMcpSessionManager } from '../../src/mcp-session-manager.js'
import { OWNER_A } from '../coding-session-harness.js'

const [configPath, out] = process.argv.slice(2) as [string, string]

if (!existsSync(out)) {
  const manager = createExecutorMcpSessionManager([{
    name: 'coding-sessions',
    command: [
      process.execPath, '--import', 'tsx', fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
      'serve-coding-session-mcp', '--config', configPath,
    ],
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { NESSIE_EXECUTOR_SUPERVISOR: 'service' },
  }], { maxResultBytes: 65_536 }, { idleTimeoutMs: 600_000, log: () => undefined, startTimeoutMs: 30_000 })
  const result = await manager.callTool('coding-sessions', 'session_start', {
    agent: 'claude', root: 'work', prompt: '#hold=restart work across the restart',
  }, { 'nessie/owner': OWNER_A, 'nessie/command': randomUUID() }) as { content?: { text?: string }[] }
  const { sessionId } = JSON.parse(result.content?.[0]?.text ?? '{}') as { sessionId?: string }
  writeFileSync(out, JSON.stringify({ sessionId: sessionId ?? null }))
}
setInterval(() => undefined, 60_000)
