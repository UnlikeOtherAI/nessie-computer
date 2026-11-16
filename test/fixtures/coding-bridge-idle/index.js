import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

if (process.argv.includes('serve-coding-session-mcp')) {
  await import('../scripted-mcp-server.mjs')
} else {
  const { codingSessionsServer, isTrustedCodingControlBridge } = await import('../../../src/coding-sessions-policy.ts')
  const { createExecutorMcpSessionManager } = await import('../../../src/mcp-session-manager.ts')
  const { codingProcessIsAlive } = await import('../../../src/coding-session/process-control.ts')
  const directory = process.argv[2]
  const startLog = join(directory, 'starts')
  const spec = codingSessionsServer(join(directory, 'config.json'), 'sha256:' + 'a'.repeat(64))
  spec.env.NESSIE_TEST_MCP_START_LOG = startLog
  assert.equal(isTrustedCodingControlBridge(spec), true)
  const sessions = createExecutorMcpSessionManager([spec], { maxResultBytes: 65536 }, {
    idleTimeoutMs: 100, startTimeoutMs: 15000, log: () => {},
  })
  let pid
  try {
    assert.equal((await sessions.callTool(spec.name, 'echo', { value: 'first' })).success, true)
    pid = Number((await readFile(startLog, 'utf8')).trim())
    assert.ok(codingProcessIsAlive(pid))
    // Real wall time and a real stdio process: no fake timers or injected trust decision.
    await delay(350)
    assert.ok(codingProcessIsAlive(pid), 'idle cleanup killed the trusted coding bridge')
    const followup = await sessions.callTool(spec.name, 'echo', { value: 'follow-up' })
    assert.equal(followup.success, true)
    assert.match(JSON.stringify(followup), /follow-up/u)
    assert.equal((await readFile(startLog, 'utf8')).trim(), String(pid), 'same bridge handles the follow-up')
  } finally {
    await sessions.stopAll()
  }
  for (let attempt = 0; attempt < 100 && codingProcessIsAlive(pid); attempt += 1) await delay(25)
  assert.equal(codingProcessIsAlive(pid), false, 'normal shutdown still closes the bridge')

  const impostorLog = join(directory, 'impostor-starts')
  const impostor = {
    ...spec,
    command: [process.execPath, fileURLToPath(new URL('../scripted-mcp-server.mjs', import.meta.url)),
      'serve-coding-session-mcp', '--config', join(directory, 'config.json')],
    env: { ...spec.env, NESSIE_TEST_MCP_START_LOG: impostorLog },
  }
  assert.equal(isTrustedCodingControlBridge(impostor), false)
  const ordinary = createExecutorMcpSessionManager([impostor], { maxResultBytes: 65536 }, {
    idleTimeoutMs: 100, startTimeoutMs: 15000, log: () => {},
  })
  try {
    assert.equal((await ordinary.listTools(impostor.name)).success, true)
    const ordinaryPid = Number((await readFile(impostorLog, 'utf8')).trim())
    for (let attempt = 0; attempt < 100 && codingProcessIsAlive(ordinaryPid); attempt += 1) await delay(25)
    assert.equal(codingProcessIsAlive(ordinaryPid), false, 'a matching name and flags cannot retain an arbitrary app')
  } finally {
    await ordinary.stopAll()
  }
  process.stdout.write('bridge retained across idle; same-process follow-up; shutdown and untrusted idle close passed\n')
}
