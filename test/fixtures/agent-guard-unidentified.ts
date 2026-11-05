/**
 * The agent guard as the guard's suite runs it when an agent's start time
 * cannot be read: `identify` answers nothing, once the agent has written its
 * pids to `GUARD_TEST_PIDS`, the way three `ps` calls timing out on a loaded
 * Mac do. With `GUARD_TEST_NO_TABLE=1` no table can be read for its tree
 * either. Started by a host, which holds its pipe at fd 3, in place of
 * `nessie-executor coding-session-agent-guard`.
 *
 *   node --import tsx agent-guard-unidentified.ts
 */
import { existsSync } from 'node:fs'

import { runCodingAgentGuard } from '../../src/coding-session/agent-guard.js'
import { createCodingProcessControl } from '../../src/coding-session/process-control.js'

const control = createCodingProcessControl(process.platform, { termGraceMs: 3_000 })

const agentWrote = async (): Promise<void> => {
  const deadline = Date.now() + 20_000
  while (!existsSync(process.env.GUARD_TEST_PIDS!) && Date.now() < deadline) {
    await new Promise((settle) => { setTimeout(settle, 50) })
  }
}

await runCodingAgentGuard({
  ...control,
  identify: async () => {
    await agentWrote()
    return undefined
  },
  ...(process.env.GUARD_TEST_NO_TABLE === '1' ? { killChildTree: async () => false } : {}),
})
