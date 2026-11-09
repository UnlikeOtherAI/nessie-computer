import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { ExecutorApiError, type ExecutorApiClient } from '../src/api-client.js'
import { claimExecutor } from '../src/daemon-connection.js'
import { loadExecutorState, saveExecutorState, type ExecutorLocalState } from '../src/state-store.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const stateFor = (): ExecutorLocalState => ({
  apiBaseUrl: 'https://executor.example.test', executorId: '00000000-0000-4000-8000-000000000001',
  machinePrivateKey: generateKeyPairSync('ed25519').privateKey
    .export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  machinePublicKey: 'unused', workspaceFolders: [{ name: 'work', path: join(tmpdir(), 'nessie-claim-workspace') }],
  descriptor: { revision: 4, operationKeys: ['mcp.tools'], profiles: ['workspace_sandbox'],
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65536, maxSessions: 1 } },
})
const conflict = () => new ExecutorApiError('Immutable revision changed', {
  code: 'EXECUTOR_DESCRIPTOR_REVISION_CONFLICT', status: 409,
})
const apiFor = (submitDescriptor: ExecutorApiClient['submitDescriptor']) => ({
  issueChallenge: async () => ({ challenge: 'challenge', expiresAt: '2099-01-01T00:00:00Z' }),
  claim: async () => ({ connectionEpoch: 'new-epoch', status: 'online' }), submitDescriptor,
})

test('reconnect publishes current persisted policy under a fresh durable revision after a conflict', async () => {
  const original = stateFor()
  const persisted = { ...original, descriptor: { ...original.descriptor, revision: 7, mcpServers: ['kelpie'] } }
  let stored = persisted
  const revisions: number[] = []
  const result = await claimExecutor('unused', original, {
    api: apiFor(async (_url, input) => {
      const signed = input.descriptor as { descriptor: { revision: number; mcpServers: string[] } }
      revisions.push(signed.descriptor.revision)
      assert.deepEqual(signed.descriptor.mcpServers, ['kelpie'])
      if (revisions.length === 1) throw conflict()
      assert.equal(stored.descriptor.revision, 8, 'persist before retrying the network effect')
      return { reviewStatus: 'approved', revision: 8 }
    }),
    loadState: async () => persisted,
    saveState: async (_dir, next, expected) => {
      assert.equal(expected, persisted)
      stored = next
    },
  })
  assert.deepEqual(revisions, [7, 8])
  assert.equal(result.connectionEpoch, 'new-epoch')
  assert.equal(Object.hasOwn(result, 'sessionPairingSource'), false)
  assert.doesNotThrow(() => canonicalExecutorJson(result), 'claim state must remain canonicalizable for live reload')
  assert.deepEqual(result.descriptor, { ...persisted.descriptor, revision: 8 })
})

test('reconnect does not rewrite a revision for rollback, fencing or transport failures', async () => {
  for (const error of [new ExecutorApiError('rollback', { code: 'EXECUTOR_DESCRIPTOR_ROLLBACK' }),
    new ExecutorApiError('fenced', { code: 'EXECUTOR_CONNECTION_FENCED' }), new Error('network')]) {
    const state = stateFor()
    await assert.rejects(claimExecutor('unused', state, {
      api: apiFor(async () => { throw error }), loadState: async () => state,
      saveState: async () => { assert.fail('must not save on this error') },
    }), failure => failure === error)
  }
})

test('reconnect stops on concurrent local policy changes and bounds repeated conflicts', async () => {
  const state = stateFor()
  for (const changed of [true, false]) {
    let attempts = 0
    await assert.rejects(claimExecutor('unused', state, {
      api: apiFor(async () => { attempts += 1; throw conflict() }), loadState: async () => state,
      saveState: async () => { if (changed) throw new Error('Executor state changed') },
    }), changed ? /state changed/ : /Immutable revision changed/)
    assert.equal(attempts, changed ? 1 : 2)
  }
})

test('reconnect replays the protected saved revision after a lost retry response', {
  skip: WINDOWS_STATE_HELPER_SKIP,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-claim-replay-'))
  try {
    const state = stateFor()
    await saveExecutorState(directory, state)
    let attempts = 0
    await assert.rejects(claimExecutor(directory, state, {
      api: apiFor(async () => { if (++attempts === 1) throw conflict(); throw new Error('response lost') }),
      loadState: loadExecutorState, saveState: saveExecutorState,
    }), /response lost/)
    const saved = await loadExecutorState(directory)
    assert.equal(saved.descriptor.revision, 5)
    const replay = await claimExecutor(directory, saved, {
      api: apiFor(async (_url, input) => {
        assert.equal((input.descriptor as { descriptor: { revision: number } }).descriptor.revision, 5)
        return { reviewStatus: 'approved', revision: 5 }
      }), loadState: loadExecutorState, saveState: saveExecutorState,
    })
    assert.equal(replay.descriptor.revision, 5)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
