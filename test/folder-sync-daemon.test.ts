import assert from 'node:assert/strict'
import { randomUUID, verify } from 'node:crypto'
import test from 'node:test'

import { ExecutorDaemonHeartbeatWithFolderSyncRequestSchema, canonicalExecutorPayload } from '@nessie/executor-protocol'

import { heartbeatExecutor } from '../src/daemon-connection.js'
import type { ExecutorLocalState } from '../src/state-store.js'
import { FolderSyncFakeServer } from './support/folder-sync-fake-server.js'

const summary = {
  requested: true, state: 'syncing' as const, pending: 2, openConflicts: 0, heldDeletes: 0,
  lastReconcileAt: '2026-11-03T10:00:00.000Z',
}

const beat = async (folderSync?: typeof summary) => {
  const keys = new FolderSyncFakeServer()
  let sent: Record<string, unknown> | null = null
  const state = {
    apiBaseUrl: 'https://nessie.test', executorId: randomUUID(), connectionEpoch: '3',
    machinePrivateKey: keys.machinePrivateKey,
  } as unknown as ExecutorLocalState
  await heartbeatExecutor(state, undefined, undefined, folderSync, {
    heartbeat: async (_url, body) => {
      sent = body as Record<string, unknown>
      return { connectionEpoch: '3', status: 'online' }
    },
  })
  const { signature, ...payload } = sent! as { signature: string }
  const signed = verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.heartbeat.v1', payload)),
    keys.publicKey, Buffer.from(signature, 'base64url'))
  return { sent: sent!, signed }
}

test('the heartbeat carries the folder sync summary, signed, in the shared heartbeat contract', async () => {
  const { sent, signed } = await beat(summary)
  assert.ok(signed)
  assert.deepEqual(sent.folderSync, summary)
  assert.ok(ExecutorDaemonHeartbeatWithFolderSyncRequestSchema.safeParse(sent).success)
})

test('a daemon with sync never switched on signs exactly the heartbeat it always did', async () => {
  const { sent, signed } = await beat()
  assert.ok(signed)
  assert.equal('folderSync' in sent, false)
})
