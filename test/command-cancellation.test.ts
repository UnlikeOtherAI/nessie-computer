import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  canonicalExecutorPayload, EXECUTOR_COMMAND_CANCELLED_RESULT,
  ExecutorCommandCancellationTargetSchema, type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { ExecutorApiError, type ExecutorApiClient } from '../src/api-client.js'
import { executeWithCommandCancellation } from '../src/command-cancellation.js'
import { recoverOrPollExecutorCommand, type ExecutorCommandRecovery } from '../src/command-recovery.js'
import { createExecutorMcpSessionManager } from '../src/mcp-session-manager.js'
import { createCodingProcessControl } from '../src/coding-session/process-control.js'
import { CODING_SESSIONS_CONFIG_DIGEST_ENV } from '../src/coding-session/config.js'

const keys = generateKeyPairSync('ed25519')
const state = {
  apiBaseUrl: 'https://example.test', connectionEpoch: '1', executorId: '00000000-0000-4000-8000-000000000501',
  machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
}
const command: ExecutorCommandEnvelope = {
  argumentDigest: `sha256:${'1'.repeat(64)}`, bindingFence: '1', bindingId: '00000000-0000-4000-8000-000000000502',
  capabilityRevision: 1, commandId: '00000000-0000-4000-8000-000000000503',
  expiresAt: '2099-08-12T12:00:00.000Z', idempotencyKey: 'cancel-test', operationKey: 'mcp.call',
  payload: { args: { server: 'tree', tool: 'hang' }, runId: '00000000-0000-4000-8000-000000000504' },
}
const cancellation = {
  ...ExecutorCommandCancellationTargetSchema.strip().parse(command), requestedAt: new Date().toISOString(),
}

test('a queued cancel prevents execution; the cancellation poll signs every command fence in its own domain', async () => {
  let executed = false
  const result = await executeWithCommandCancellation({ command, state, cancel: async () => undefined,
    execute: async () => { executed = true; return { success: true } },
    api: { pollCommand: async (_url, request) => {
      const { signature, ...payload } = request
      assert(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.cancel.v1', payload)),
        keys.publicKey, Buffer.from(signature, 'base64url')))
      assert.deepEqual(request.activeCommand, ExecutorCommandCancellationTargetSchema.strip().parse(command))
      return { command: null, cancellation }
    } },
  })
  assert.equal(executed, false)
  assert.deepEqual(result, EXECUTOR_COMMAND_CANCELLED_RESULT)
})

test('an active command fenced by reconnection stops instead of waiting on the old epoch until TTL', async () => {
  let stopped = false
  let finish!: () => void
  let polls = 0
  const result = await executeWithCommandCancellation({ command, state, intervalMs: 5,
    cancel: async () => { stopped = true; finish() },
    execute: async () => {
      await new Promise<void>(resolve => { finish = resolve })
      return { success: true }
    },
    api: { pollCommand: async () => {
      if (++polls === 1) return { command: null }
      throw new ExecutorApiError('Fenced', { code: 'EXECUTOR_CONNECTION_FENCED', status: 409 })
    } },
  })
  assert.equal(stopped, true)
  assert.deepEqual(result, EXECUTOR_COMMAND_CANCELLED_RESULT)
})

test('mismatched or unsupported cancellation cannot stop a command; late control responses are discarded', async () => {
  let cancelled = false
  let release!: (response: Awaited<ReturnType<ExecutorApiClient['pollCommand']>>) => void
  let polls = 0
  const result = await executeWithCommandCancellation({ command, state, intervalMs: 5,
    cancel: async () => { cancelled = true },
    execute: async () => { await delay(25); return { success: true } },
    api: { pollCommand: async () => {
      polls += 1
      if (polls === 1) return { command: null, cancellation: { ...cancellation, bindingFence: '999' } }
      return new Promise(resolve => { release = resolve })
    } },
  })
  assert.deepEqual(result, { success: true })
  assert.equal(polls, 2, 'a delayed control request suppresses further polls')
  release({ command: null, cancellation })
  await delay(10)
  assert.equal(cancelled, false, 'a completed command cannot be cancelled by a late response')
  const legacy = await executeWithCommandCancellation({ command, state, cancel: async () => { cancelled = true },
    execute: async () => ({ success: true }), api: { pollCommand: async () => ({ command: null }) },
  })
  assert.deepEqual(legacy, { success: true })
  assert.equal(cancelled, false)
})

test('cancellation waits for local teardown, discards late output, and replays a lost receipt without execution', async () => {
  let finish!: () => void
  let teardownDone = false
  let polls = 0
  let executed = 0
  const execute = () => executeWithCommandCancellation({ command, state, intervalMs: 5,
    cancel: async () => { await delay(25); teardownDone = true; finish() },
    execute: async () => {
      executed += 1
      await new Promise<void>(resolve => { finish = resolve })
      return { success: true, content: 'late private output' }
    },
    api: { pollCommand: async () => ({ command: null, cancellation: ++polls > 1 ? cancellation : null }) },
  })
  let journal: ExecutorCommandRecovery | null = null
  let lost = true
  const input = {
    execute,
    store: {
      load: async () => journal,
      save: async (row: ExecutorCommandRecovery) => { journal = structuredClone(row) },
      clear: async () => { journal = null },
    },
    transport: {
      poll: async () => command,
      receipt: async (receipt: { state: string; result?: Record<string, unknown> }) => {
        if (receipt.state !== 'result_acknowledged') return
        assert.equal(teardownDone, true)
        assert.deepEqual(receipt.result, EXECUTOR_COMMAND_CANCELLED_RESULT)
        if (lost) { lost = false; throw new Error('lost response') }
      },
    },
  }
  await assert.rejects(recoverOrPollExecutorCommand(input), /lost response/)
  assert.equal((journal as ExecutorCommandRecovery | null)?.phase, 'result_pending')
  await recoverOrPollExecutorCommand(input)
  assert.equal(executed, 1)
  assert.equal(journal, null)
})

test('a cancelled MCP command terminates its real process tree and another server remains usable', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-cancel-tree-'))
  const path = join(directory, 'tree.log')
  const sessions = createExecutorMcpSessionManager([
    { name: 'tree', command: [process.execPath, fileURLToPath(new URL('./fixtures/cancellation-mcp-server.mjs', import.meta.url))],
      env: { NESSIE_TEST_TREE_LOG: path } },
    { name: 'other', command: [process.execPath, fileURLToPath(new URL('./fixtures/scripted-mcp-server.mjs', import.meta.url))] },
  ], { maxResultBytes: 65_536 })
  let pids: number[] = []
  try {
    assert.equal((await sessions.callTool('other', 'echo')).success, true)
    const result = await executeWithCommandCancellation({ command, state, intervalMs: 25,
      cancel: async () => undefined,
      execute: signal => sessions.callTool('tree', 'hang', undefined, undefined, undefined, signal),
      api: { pollCommand: async () => {
        try { pids = (await readFile(path, 'utf8')).trim().split('\n').map(Number) } catch { /* not spawned yet */ }
        return { command: null, cancellation: pids.length === 3 ? cancellation : null }
      } },
    })
    assert.deepEqual(result, EXECUTOR_COMMAND_CANCELLED_RESULT)
    assert.equal(pids.length, 3, 'the child and grandchild reached execution before cancellation')
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/, `process ${pid} survived cancellation`)
    assert.equal((await sessions.callTool('other', 'echo')).success, true)
  } finally {
    await sessions.stopAll()
    await rm(directory, { recursive: true, force: true })
  }
})

test('cancellation during a local MCP handshake stops startup before a tool is sent', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-cancel-start-'))
  const path = join(directory, 'start.log')
  const sessions = createExecutorMcpSessionManager([{
    name: 'starting', command: [process.execPath,
      fileURLToPath(new URL('./fixtures/scripted-mcp-server.mjs', import.meta.url))],
    env: { NESSIE_TEST_MCP_INIT_DELAY_MS: '60000', NESSIE_TEST_MCP_START_LOG: path },
  }], { maxResultBytes: 65_536 }, { log: () => undefined })
  let pid: number | undefined
  try {
    const result = await executeWithCommandCancellation({ command, state, intervalMs: 10,
      cancel: async () => undefined,
      execute: signal => sessions.callTool('starting', 'echo', undefined, undefined, undefined, signal),
      api: { pollCommand: async () => {
        try { pid = Number((await readFile(path, 'utf8')).trim()) } catch { /* not spawned yet */ }
        return { command: null, cancellation: pid ? cancellation : null }
      } },
    })
    assert.deepEqual(result, EXECUTOR_COMMAND_CANCELLED_RESULT)
    assert.ok(pid)
    assert.throws(() => process.kill(pid!, 0), /ESRCH/)
  } finally {
    await sessions.stopAll()
    await rm(directory, { recursive: true, force: true })
  }
})

test('cancelling a built-in bridge request preserves durable hosts from an earlier completed command', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-cancel-host-'))
  const path = join(directory, 'hosts.log')
  const sessions = createExecutorMcpSessionManager([{
    name: 'coding-sessions', command: [process.execPath,
      fileURLToPath(new URL('./fixtures/cancellation-mcp-server.mjs', import.meta.url)),
      'serve-coding-session-mcp', '--config', join(directory, 'config.json')],
    env: { NESSIE_TEST_TREE_LOG: path, NESSIE_TEST_PERSISTENT_HOST: '1', [CODING_SESSIONS_CONFIG_DIGEST_ENV]: 'reviewed' },
  }], { maxResultBytes: 65_536 }, { log: () => undefined })
  let pids: number[] = []
  const control = createCodingProcessControl()
  let started = false
  try {
    assert.equal((await sessions.callTool('coding-sessions', 'persist')).success, true)
    const result = await executeWithCommandCancellation({ command, state, intervalMs: 25,
      cancel: async () => undefined,
      execute: signal => {
        started = true
        return sessions.callTool('coding-sessions', 'hang', undefined, undefined, undefined, signal)
      },
      api: { pollCommand: async () => {
        try { pids = (await readFile(path, 'utf8')).trim().split('\n').map(Number) } catch { /* not spawned yet */ }
        return { command: null, cancellation: started && pids.length === 3 ? cancellation : null }
      } },
    })
    assert.deepEqual(result, EXECUTOR_COMMAND_CANCELLED_RESULT)
    assert.throws(() => process.kill(pids[0]!, 0), /ESRCH/, 'the bridge control process ended')
    for (const pid of pids.slice(1)) assert.doesNotThrow(() => process.kill(pid, 0), 'a durable host was killed')
  } finally {
    const host = pids[1] ? await control.identify(pids[1]) : undefined
    if (host) await control.killTree(host)
    await sessions.stopAll()
    await rm(directory, { recursive: true, force: true })
  }
})
