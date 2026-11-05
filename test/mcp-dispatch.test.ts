import assert from 'node:assert/strict'
import { test } from 'node:test'

import { executeExecutorMcpCommand } from '../src/mcp-dispatch.js'
import type { ExecutorMcpSessionManager } from '../src/mcp-session-manager.js'

/**
 * The envelope refusal is the model's only clue: it used to be a bare code,
 * so a model that sent `arguments` as a JSON string retried the same call
 * until the breaker tripped. It now names the field and says what is wrong.
 */

const untouched = (): ExecutorMcpSessionManager & { calls: number } => {
  const sessions = {
    calls: 0,
    callTool: async () => {
      sessions.calls += 1
      return { success: true }
    },
    listTools: async () => {
      sessions.calls += 1
      return { success: true }
    },
    probe: async () => ({ available: false as const, reason: 'not_probed' as const }),
    stopAll: async () => undefined,
  }
  return sessions
}

test('a JSON-string arguments value is refused with the field named', async () => {
  const sessions = untouched()
  const refused = await executeExecutorMcpCommand('mcp.call', {
    arguments: '{"url":"https://example.com"}',
    server: 'kelpie',
    tool: 'navigate',
  }, sessions)
  assert.deepEqual(refused, {
    code: 'EXECUTOR_COMMAND_ARGUMENTS_INVALID',
    fields: ['arguments'],
    message: 'The mcp.call arguments were refused — `arguments`: Expected object, received string.',
    success: false,
  })
  assert.equal(sessions.calls, 0, 'nothing reached the program')
})

test('an unexpected field and a missing one are both named', async () => {
  const refused = await executeExecutorMcpCommand('mcp.tools', { cursor: 1, tool: 'navigate' }, untouched())
  assert.equal(refused.code, 'EXECUTOR_COMMAND_ARGUMENTS_INVALID')
  assert.deepEqual([...(refused.fields as string[])].sort(), ['cursor', 'server', 'tool'])
  assert.match(String(refused.message), /unexpected `tool`/)
  assert.match(String(refused.message), /`server`: Required/)
  assert.match(String(refused.message), /`cursor`: Expected string, received number/)
})

test('the refusal never repeats a value the model sent', async () => {
  const secret = 'sk-live-canary-value'
  const refused = await executeExecutorMcpCommand('mcp.call', {
    arguments: secret,
    server: 'Not A Server',
    tool: 'x',
  }, untouched())
  assert.doesNotMatch(JSON.stringify(refused), new RegExp(secret))
  assert.doesNotMatch(JSON.stringify(refused), /Not A Server/)
})

test('a payload with many faults names only the first few, each bounded', async () => {
  const flood = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`${'k'.repeat(200)}${index}`, index]))
  const refused = await executeExecutorMcpCommand('mcp.call', { ...flood, server: 'kelpie', tool: 'x' }, untouched())
  assert.ok((refused.fields as string[]).length <= 5)
  assert.ok((refused.fields as string[]).every((field) => field.length <= 64))
  assert.ok(String(refused.message).length < 1_000)
})

test('a valid envelope still passes the program’s arguments through untouched', async () => {
  const seen: unknown[] = []
  const sessions = {
    ...untouched(),
    callTool: async (_server: string, _tool: string, args?: Record<string, unknown>) => {
      seen.push(args)
      return { success: true }
    },
  }
  await executeExecutorMcpCommand('mcp.call', {
    arguments: { timeoutMs: '40', unknownToNessie: { nested: true } },
    server: 'kelpie',
    tool: 'navigate',
  }, sessions)
  assert.deepEqual(seen, [{ timeoutMs: '40', unknownToNessie: { nested: true } }])
})


const identity = (tail: number) => `00000000-0000-4000-8000-${String(tail).padStart(12, '0')}`
const privateAuthority = {
  principal: { serverOrigin: 'https://paired.example', identityIssuer: 'https://identity.example',
    organizationId: identity(1), teamId: identity(2), ownerUserId: identity(3), ownerSubject: 'stable-owner' },
  agent: { kind: 'private', id: identity(4), ownerUserId: identity(3), teamId: identity(2) },
  origin: { kind: 'interactive', requestingUserId: identity(3), rootRunId: identity(5) },
  runId: identity(5), rootRunId: identity(5), soleReaderUserId: identity(3),
}

test('signed custom discovery and calls carry admission authority without a bridge owner', async () => {
  const seen: unknown[] = []
  const sessions = { ...untouched(),
    listTools: async (_server: string, _cursor?: string, _signal?: AbortSignal, authority?: unknown) => {
      seen.push(authority)
      return { success: true }
    },
    callTool: async (_server: string, _tool: string, _args?: Record<string, unknown>,
      meta?: Record<string, unknown>) => {
      seen.push(meta?.['nessie/personal-authority'])
      return { success: true }
    },
  }
  for (const operation of ['mcp.tools', 'mcp.call'] as const) {
    const args = operation === 'mcp.tools' ? { server: 'kelpie' } : { server: 'kelpie', tool: 'navigate' }
    assert.equal((await executeExecutorMcpCommand(operation, args, sessions, { commandId: identity(6),
      payload: { args, runId: identity(5), personalAuthority: privateAuthority } })).success, true)
  }
  assert.deepEqual(seen, [privateAuthority, privateAuthority])
})

test('authority with another run or a mismatched bridge owner never reaches the session manager', async () => {
  const sessions = untouched()
  const args = { server: 'coding-sessions', tool: 'terminal_start' }
  for (const extra of [
    { runId: identity(99) },
    { owner: { agentId: identity(99), actorUserId: identity(3) } },
    { owner: { agentId: identity(4), actorUserId: identity(99) } },
  ]) {
    const result = await executeExecutorMcpCommand('mcp.call', args, sessions, { commandId: identity(6),
      payload: { args, runId: identity(5), personalAuthority: privateAuthority, ...extra } })
    assert.equal(result.code, 'EXECUTOR_PERSONAL_AUTHORITY_INVALID')
  }
  assert.equal(sessions.calls, 0)
})
