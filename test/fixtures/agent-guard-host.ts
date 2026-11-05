/**
 * Stands in for a session host in the guard's suite: it starts one agent
 * through the agent guard exactly as a host does, prints the guard's pid and
 * the identity the guard reported, relays the agent's own output, and then
 * waits to be killed.
 *
 *   node --import tsx agent-guard-host.ts '<agent script for node -e>'
 */
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { AGENT_GUARD_COMMAND, guardedProcessControl } from '../../src/coding-session/agent-guard.js'
import { createCodingProcessControl } from '../../src/coding-session/process-control.js'

const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url))
const control = guardedProcessControl(createCodingProcessControl(process.platform, {}), {
  argv: [process.execPath, ...process.execArgv, entry, AGENT_GUARD_COMMAND], cwd: process.cwd(), env: process.env,
})
const guard = control.spawnAgent(process.execPath, ['-e', process.argv[2]!], { cwd: tmpdir(), env: process.env })
guard.stdout?.pipe(process.stdout)
const agent = await control.identifySpawned?.(guard)
process.stdout.write(`${JSON.stringify({ guard: guard.pid, agent })}\n`)
setInterval(() => undefined, 60_000)
