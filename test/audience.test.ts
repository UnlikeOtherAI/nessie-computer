import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalExecutorPayload, type ExecutorDaemonAudienceRequest } from '@nessie/executor-protocol'

import { readAudience, requestAudience } from '../src/audience.js'
import { saveExecutorState, type ExecutorLocalState } from '../src/state-store.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const keys = generateKeyPairSync('ed25519')
const now = () => new Date('2026-11-08T12:00:00.000Z')

const state: ExecutorLocalState = {
  apiBaseUrl: 'https://api.example.test',
  connectionEpoch: '42',
  descriptor: {
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: ['file.read'], profiles: ['workspace_sandbox'], revision: 3,
  },
  executorId: '00000000-0000-4000-8000-000000000802',
  machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  machinePublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  workspaceFolders: [{ name: 'workspace', path: '/private/workspace' }],
}

const answer = {
  agents: [{ id: 'agent-1', name: 'Sales assistant' }], everyoneInTeam: true,
  people: [{ name: 'Owner', isOwner: true }], peopleCount: 1, projects: [], observedAt: '2026-11-08T12:00:01.000Z',
}

test('the audience request is signed by the machine key over the connection, under its own domain', async () => {
  const sent: Array<{ baseUrl: string; input: ExecutorDaemonAudienceRequest }> = []
  const response = await requestAudience(state, { audience: async (baseUrl, input) => {
    sent.push({ baseUrl, input })
    return answer
  } }, now)
  assert.deepEqual(response, answer)
  assert.equal(sent.length, 1)
  const { signature, ...payload } = sent[0]!.input
  assert.equal(sent[0]!.baseUrl, state.apiBaseUrl)
  assert.deepEqual(payload, { connectionEpoch: '42', executorId: state.executorId, observedAt: '2026-11-08T12:00:00.000Z' })
  const publicKey = createPublicKey(keys.publicKey.export({ format: 'pem', type: 'spki' }))
  assert.ok(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.audience.v1', payload)), publicKey,
    Buffer.from(signature, 'base64url')))
  assert.equal(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.heartbeat.v1', payload)),
    publicKey, Buffer.from(signature, 'base64url')), false, 'a heartbeat signature is not an audience one')
})

test('an unconnected team is told so, and a malformed answer is refused', async () => {
  const { connectionEpoch: _epoch, ...unclaimed } = state
  await assert.rejects(requestAudience(unclaimed, { audience: async () => answer }, now), /not connected yet/)
  await assert.rejects(requestAudience(state, { audience: async () => ({ ...answer, people: 'everyone' }) }, now))
})

test('reading the audience persists nothing', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-audience-'))
  try {
    await saveExecutorState(stateDir, state)
    const before = await readdir(stateDir)
    const stateFile = await readFile(join(stateDir, 'executor-state.json'), 'utf8')
    assert.deepEqual(await readAudience(stateDir, { api: { audience: async () => answer }, now }), answer)
    assert.deepEqual(await readdir(stateDir), before)
    assert.equal(await readFile(join(stateDir, 'executor-state.json'), 'utf8'), stateFile)
  } finally { await rm(stateDir, { force: true, recursive: true }) }
})
