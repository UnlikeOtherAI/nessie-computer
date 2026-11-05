import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'

import { createCodingHarness } from '../test/coding-session-harness.js'

// Explicit operator-run smoke, never an automatic test that spends a subscription.
// Start two instances of the named real CLI, as an agent names it, under
// allow-all command rules, and control them over the executor's actual MCP
// transport. All state and work are temporary.
const command: unknown = JSON.parse(process.env.NESSIE_TERMINAL_SMOKE_COMMAND ?? 'null')
assert(Array.isArray(command) && command.length && command.every((part) => typeof part === 'string'))
const harness = await createCodingHarness({
  agentEnv: { inheritUserSession: true, set: {
    PATH: process.env.PATH ?? '',
    ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
  } },
})
const lines = createInterface({ input: process.stdin })
const ids: string[] = []
let stopped = false
try {
  for (const title of ['Live CLI one', 'Live CLI two']) {
    const result = await harness.call('session_start', { agent: 'terminal', command, cwd: harness.root, title })
    assert.equal(result.ok, true, JSON.stringify(result.body))
    ids.push(String(result.body.sessionId))
  }
  console.log(JSON.stringify({ sessions: ids, platform: process.platform }))
  const previous = new Map<string, string>()
  const poll = (async () => {
    while (!stopped) {
      for (const [index, sessionId] of ids.entries()) {
        const answer = await harness.call('terminal_read', { sessionId })
        const text = String(answer.body.text ?? JSON.stringify(answer.body))
        if (previous.get(sessionId) !== text) {
          previous.set(sessionId, text)
          console.log(JSON.stringify({ index, status: answer.body.status, screen: text }))
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  })()
  for await (const line of lines) {
    const input = JSON.parse(line) as { index?: number; data?: string; action?: string }
    if (input.action === 'finish') break
    if (input.action === 'reconnect') {
      await harness.restartBridge()
      console.log('MCP transport reconnected; sessions retained')
    } else {
      const sessionId = ids[input.index ?? 0]
      assert(sessionId)
      const answer = await harness.call(input.action === 'close' ? 'session_close' : 'session_send', {
        sessionId, ...(input.action === 'close' ? {} : { message: input.data, terminal: true }),
      })
      assert.equal(answer.ok, true, JSON.stringify(answer.body))
      console.log(JSON.stringify({ accepted: true, index: input.index ?? 0 }))
    }
  }
  stopped = true
  await poll
} finally {
  stopped = true
  lines.close()
  await harness.cleanup()
}
