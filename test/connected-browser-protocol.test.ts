import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { canonicalExecutorJson, type ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import {
  createConnectedBrowserFrameGate,
  type ConnectedBrowserTransport,
} from '../src/connected-browser-protocol.js'
import { createExecutorConnectedBrowserSessionManager } from '../src/connected-browser-session-manager.js'
import type { ExecutorLocalState } from '../src/state-store.js'

const runId = '00000000-0000-4000-8000-000000000610'

const commandFor = (
  operationKey: 'browser.connected.open' | 'browser.connected.observe' | 'browser.connected.act',
  args: Record<string, unknown>,
): ExecutorCommandEnvelope => {
  const payload = { args, runId }
  return {
    argumentDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}` as never,
    bindingFence: '1',
    bindingId: '00000000-0000-4000-8000-000000000611' as never,
    capabilityRevision: 1,
    commandId: '00000000-0000-4000-8000-000000000612' as never,
    expiresAt: '2099-08-12T12:00:00.000Z',
    idempotencyKey: `connected-browser-${operationKey}`,
    operationKey,
    payload,
  }
}

const state: ExecutorLocalState = {
  apiBaseUrl: 'https://api.example.test',
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: ['browser.connected.open', 'browser.connected.observe', 'browser.connected.act', 'sandbox.stop'],
    profiles: ['connected_browser'],
    revision: 1,
  },
  executorId: '00000000-0000-4000-8000-000000000613',
  machinePrivateKey: 'private',
  machinePublicKey: 'public',
  workspaceFolders: [{ name: 'workspace', path: '/private/workspace' }],
}

test('native extension frames are replay-fenced, origin-bounded, and redact structural sensitive controls', () => {
  const gate = createConnectedBrowserFrameGate({ allowedOrigins: new Set(['https://app.example.test']), capability: 'capability' })
  assert.deepEqual(gate.parse({
    capability: 'capability',
    observation: {
      accessibilityTree: [
        { name: 'Save', nodeId: 1, role: 'button' },
        { name: 'Password', nodeId: 2, role: 'textbox', sensitive: true, value: 'never' },
      ],
      url: 'https://app.example.test/settings',
    },
    sequence: 1,
    type: 'connected_browser.observation',
  }), {
    capability: 'capability',
    observation: {
      accessibilityTree: [{ name: 'Save', nodeId: 1, role: 'button' }],
      url: 'https://app.example.test/settings',
    },
    sequence: 1,
    type: 'connected_browser.observation',
  })
  assert.equal(gate.parse({ capability: 'capability', sequence: 1, type: 'connected_browser.stopped' }), null)
  assert.equal(gate.parse({ capability: 'capability', method: 'Runtime.evaluate', sequence: 2, type: 'connected_browser.cdp' }), null)
  assert.equal(gate.parse({ capability: 'other', sequence: 2, type: 'connected_browser.stopped' }), null)
})

test('connected sessions require observation, fence stale nodes, and stop on an origin transition', async () => {
  let capability = ''
  let stopped = 0
  let settledUrl = 'https://app.example.test/home'
  const transport: ConnectedBrowserTransport = {
    act: async () => ({ settledUrl }),
    observe: async () => ({
      accessibilityTree: [{ name: 'Save', nodeId: 9, role: 'button' }],
      url: 'https://app.example.test/home',
    }),
    open: async (input) => { capability = input.capability; return { tabId: 'tab-1' } },
    stop: async (input) => { assert.equal(input.capability, capability); stopped += 1 },
  }
  const manager = createExecutorConnectedBrowserSessionManager(state, {
    allowedOrigins: ['https://app.example.test'],
    transport,
  })
  assert.deepEqual(
    await manager.open(commandFor('browser.connected.open', { url: 'https://app.example.test/home' }), runId),
    { status: 'awaiting_human_tab_approval', success: true },
  )
  assert.deepEqual(
    await manager.act(commandFor('browser.connected.act', { action: 'click', nodeId: 9 }), runId),
    { code: 'EXECUTOR_CONNECTED_BROWSER_STALE_NODE', success: false },
  )
  await manager.observe(commandFor('browser.connected.observe', {}), runId)
  assert.deepEqual(
    await manager.act(commandFor('browser.connected.act', { action: 'click', nodeId: 9 }), runId),
    { settledUrl: 'https://app.example.test/home', status: 'acted', success: true },
  )
  settledUrl = 'https://elsewhere.example.test/'
  await manager.observe(commandFor('browser.connected.observe', {}), runId)
  assert.deepEqual(
    await manager.act(commandFor('browser.connected.act', { action: 'click', nodeId: 9 }), runId),
    { code: 'EXECUTOR_CONNECTED_BROWSER_ORIGIN_CHANGED', success: false },
  )
  assert.equal(stopped, 1)
})
