import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  canonicalExecutorJson,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { executeExecutorCommand } from '../src/daemon.js'
import type { ExecutorBrowserSessionManager } from '../src/browser-session-manager.js'
import type { ExecutorCommandSessionManager } from '../src/command-session-manager.js'
import type { ExecutorLocalState } from '../src/state-store.js'

const runId = '00000000-0000-4000-8000-000000000401'

const commandFor = (
  operationKey: 'browser.act' | 'command.run',
  args: Record<string, unknown>,
): ExecutorCommandEnvelope => {
  const payload = { args, runId }
  return {
    argumentDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}` as never,
    bindingFence: '1',
    bindingId: '00000000-0000-4000-8000-000000000402' as never,
    capabilityRevision: 1,
    commandId: '00000000-0000-4000-8000-000000000403' as never,
    expiresAt: '2099-08-12T12:00:00.000Z',
    idempotencyKey: `daemon-actuation-${operationKey}`,
    operationKey,
    payload,
  }
}

const state: ExecutorLocalState = {
  apiBaseUrl: 'https://api.example.test',
  browserSandbox: {
    allowedOrigins: ['https://app.example.test'],
    guestInitrdBuilderPath: '/private/builder',
    guestRuntimeBundlePath: '/private/runtime',
    kernelPath: '/private/kernel',
    vmHelperPath: '/private/helper',
  },
  descriptor: {
    commandAllowlist: ['pnpm *'],
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: ['browser.act', 'command.run'],
    profiles: ['workspace_sandbox'],
    revision: 1,
  },
  executorId: '00000000-0000-4000-8000-000000000404',
  machinePrivateKey: 'private',
  machinePublicKey: 'public',
  workspaceFolders: [{ name: 'workspace', path: '/private/workspace' }],
}

test('daemon routes actuation only to the matching mock transport after schema validation', async () => {
  const browserCalls: Array<Record<string, unknown>> = []
  const commandCalls: Array<Record<string, unknown>> = []
  const browserSessions = {
    act: async (command: ExecutorCommandEnvelope, commandRunId: string) => {
      browserCalls.push({ args: command.payload.args, runId: commandRunId })
      return { status: 'acted', success: true }
    },
  } as unknown as ExecutorBrowserSessionManager
  const commandSessions = {
    run: async (command: ExecutorCommandEnvelope, commandRunId: string) => {
      commandCalls.push({ args: command.payload.args, runId: commandRunId })
      return { exitCode: 0, output: 'done', success: true }
    },
  } as unknown as ExecutorCommandSessionManager

  assert.deepEqual(
    await executeExecutorCommand('/private/state', state, commandFor('browser.act', { action: 'click', nodeId: 9 }), {
      browserSessions,
      commandSessions,
    }),
    { status: 'acted', success: true },
  )
  assert.deepEqual(
    await executeExecutorCommand('/private/state', state, commandFor('command.run', { args: ['test'], program: 'pnpm' }), {
      browserSessions,
      commandSessions,
    }),
    { exitCode: 0, output: 'done', success: true },
  )
  assert.deepEqual(browserCalls, [{ args: { action: 'click', nodeId: 9 }, runId }])
  assert.deepEqual(commandCalls, [{ args: { args: ['test'], program: 'pnpm' }, runId }])

  assert.deepEqual(
    await executeExecutorCommand('/private/state', state, commandFor('browser.act', { action: 'click', selector: '#save' }), {
      browserSessions,
      commandSessions,
    }),
    { code: 'EXECUTOR_BROWSER_DENIED', success: false },
  )
  assert.deepEqual(
    await executeExecutorCommand('/private/state', state, commandFor('command.run', { args: ['-c', 'whoami'], program: 'sh' }), {
      browserSessions,
      commandSessions,
    }),
    { code: 'EXECUTOR_COMMAND_DENIED', success: false },
  )
  assert.equal(browserCalls.length, 1)
  assert.equal(commandCalls.length, 1)
})
