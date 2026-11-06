import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import test from 'node:test'
import { parseUpdateArguments } from '../src/updates/cli.js'
import { setImmediate } from 'node:timers/promises'
import {
  canonicalExecutorPayload, ExecutorDaemonHeartbeatWithFolderSyncRequestSchema,
  ExecutorLocalUpdateRequestSchema, type ExecutorSoftwareStatus,
} from '@nessie/executor-protocol'
import { heartbeatExecutor } from '../src/daemon-connection.js'
import type { ExecutorApiClient } from '../src/api-client.js'
import type { ExecutorLocalState } from '../src/state-store.js'

const keys = generateKeyPairSync('ed25519')
test('the public CLI exposes fixed update operations and keeps JSON explicit', () => {
  assert.deepEqual(parseUpdateArguments(['updates', 'install', '--json']), {
    request: { operation: 'install' }, json: true,
  })
  assert.deepEqual(parseUpdateArguments(['updates', 'automatic', 'off']), {
    request: { operation: 'automatic', enabled: false }, json: false,
  })
  assert.equal(parseUpdateArguments(['teams', '--json']), undefined)
  for (const args of [
    ['updates', 'install', 'https://evil.test/code'], ['updates', 'install', '--path', 'bad.exe'],
    ['updates', 'automatic', 'preview'], ['updates', '--json', 'install'], ['updates', 'install', '--json', '--json'],
  ]) assert.throws(() => parseUpdateArguments(args), /Usage:/u)
})
const state = { apiBaseUrl: 'https://nessie.test', executorId: randomUUID(), connectionEpoch: '3',
  machinePrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
} as unknown as ExecutorLocalState
const software: ExecutorSoftwareStatus = {
  format: 1, installedVersion: '1.0.0', sourceCommit: 'a'.repeat(40), automatic: true,
  channel: 'stable', phase: 'idle', canInstall: true,
}

test('software status is part of the machine signature and cannot be replaced in transit', async () => {
  let sent: Record<string, unknown> = {}
  await heartbeatExecutor(state, undefined, undefined, undefined, {
    heartbeat: async (_url, input) => { sent = input; return { connectionEpoch: '3', status: 'online' } },
  }, { status: software, onRequest: () => undefined })
  assert.ok(ExecutorDaemonHeartbeatWithFolderSyncRequestSchema.safeParse(sent).success)
  const { signature, ...payload } = sent
  const valid = (body: Record<string, unknown>) => verify(null,
    Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.heartbeat.v1', body)), keys.publicKey,
    Buffer.from(signature as string, 'base64url'))
  assert.ok(valid(payload))
  assert.equal(valid({ ...payload, software: { ...software, installedVersion: '9.0.0' } }), false)
})

test('old heartbeats omit software and update delivery failures never fail a healthy connection', async () => {
  let sent: Record<string, unknown> = {}
  const request = { requestId: randomUUID(), requestedAt: new Date().toISOString() }
  const closes = [{ ownerKey: 'owner', reason: 'requested' }]
  const api: Pick<ExecutorApiClient, 'heartbeat'> = { heartbeat: async (_url, input) => {
    sent = input
    return { connectionEpoch: '3', status: 'online', codingSessionClose: closes, softwareUpdateRequest: request }
  } }
  assert.deepEqual(await heartbeatExecutor(state, undefined, undefined, undefined, api), closes)
  assert.equal('software' in sent, false)
  let delivered = false
  assert.deepEqual(await heartbeatExecutor(state, undefined, undefined, undefined, api, {
    status: software, onRequest: async value => { delivered = value.requestId === request.requestId; throw new Error('offline') },
  }), closes)
  await setImmediate()
  assert.ok(delivered)
})

test('local update operations cannot choose code, URLs or installation paths', () => {
  for (const field of ['url', 'command', 'path', 'channel', 'version']) {
    assert.equal(ExecutorLocalUpdateRequestSchema.safeParse({ operation: 'install', [field]: 'foreign' }).success, false)
  }
  assert.ok(ExecutorLocalUpdateRequestSchema.safeParse({ operation: 'install' }).success)
  assert.ok(ExecutorLocalUpdateRequestSchema.safeParse({ operation: 'automatic', enabled: false }).success)
})
