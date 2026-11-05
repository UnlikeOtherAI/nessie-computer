import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import test from 'node:test'
import { canonicalExecutorJson, canonicalExecutorPayload, type PersonalChatgptConnectIntent } from '@nessie/executor-protocol'
import { chatgptCompanionFingerprint, renewChatgptProfileAuthority,
  validateChatgptPairingState, chatgptPreparationPublicKey } from '../src/chatgpt-profile-authority.js'
import { ChatgptProfileRecordSchema } from '../src/chatgpt-profile-records.js'
import type { ExecutorLocalState } from '../src/state-store.js'

const fixture = () => {
  const machine = generateKeyPairSync('ed25519')
  const companion = generateKeyPairSync('ed25519')
  const key = { publicKey: companion.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    privateKey: companion.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') }
  const intent: PersonalChatgptConnectIntent = { version: 1, kind: 'personal-chatgpt-connect',
    apiOrigin: 'https://nessie.example', executorId: randomUUID(), organizationId: randomUUID(), teamId: randomUUID(),
    profileId: randomUUID() }
  const state: ExecutorLocalState = { apiBaseUrl: intent.apiOrigin, executorId: intent.executorId, connectionEpoch: '7',
    machinePrivateKey: machine.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    machinePublicKey: machine.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    workspaceFolders: [], descriptor: { revision: 1, operationKeys: [], profiles: [],
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65536, maxSessions: 1 } } }
  const principal = { serverOrigin: intent.apiOrigin, identityIssuer: intent.apiOrigin,
    organizationId: intent.organizationId,
    teamId: intent.teamId, ownerUserId: randomUUID(), ownerSubject: `local:${randomUUID()}` }
  const profile = ChatgptProfileRecordSchema.parse({ format: 1, revision: 0, profileId: intent.profileId,
    apiOrigin: intent.apiOrigin, executorId: intent.executorId,
    organizationId: intent.organizationId, teamId: intent.teamId,
    phase: 'disconnected', reason: null, planEnabled: false, hostExecutionRestricted: false, operationId: null,
    principal, publicKey: key.publicKey, accountGeneration: 1, consentRevision: 1, credentialProcess: null,
    registration: { clientId: null, subject: null, issuer: 'https://auth.openai.com', extAgentHostId: randomUUID() } })
  const now = () => 1800000000000
  const authority = { challengeId: randomUUID(), nonce: 'n'.repeat(48), executorId: intent.executorId,
    profileId: intent.profileId!, connectionEpoch: '7', role: 'chatgpt' as const,
    publicKeyFingerprint: chatgptCompanionFingerprint(key), principal, deployment: 'selfHosted' as const,
    expiresAt: new Date(now() + 60000).toISOString() }
  const challenge = { ...authority,
    digest: createHash('sha256').update(canonicalExecutorJson(authority)).digest('hex') }
  let calls = 0
  const api = { personalChatgpt: async (
    _origin: string, action: 'challenge' | 'delegate' | 'disconnect', payload: unknown,
  ) => {
    calls += 1
    const input = payload as Record<string, unknown>
    const signed: Record<string, unknown> = { ...input }; delete signed.signature
    assert.equal(verify(null,
      Buffer.from(canonicalExecutorPayload(`nessie.executor.daemon.chatgpt.${action}.v1`, signed)),
      machine.publicKey, Buffer.from(String(input.signature), 'base64url')), true)
    if (action === 'challenge') return challenge
    assert.equal(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.personal-host.prove.v1', {
      challengeId: challenge.challengeId, digest: challenge.digest,
    })), companion.publicKey, Buffer.from(String(input.companionSignature), 'base64url')), true)
    return { protocolVersion: 1, nonce: input.nonce, executorId: intent.executorId, hostId: randomUUID(),
      hostConnectionEpoch: '9', delegationId: randomUUID(), profileId: intent.profileId, role: 'chatgpt',
      publicKeyFingerprint: challenge.publicKeyFingerprint, connectionEpoch: '7', principal,
      deployment: 'selfHosted', observedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + 900000).toISOString() }
  } }
  return { intent, state, profile, key, now, api, calls: () => calls, challenge }
}

test('local companion proves the server-built challenge and keeps host and parent epochs distinct', async () => {
  const f = fixture()
  const result = await renewChatgptProfileAuthority({ ...f, stateDirectory: 'fixture-only',
    readState: async () => f.state })
  assert.equal(result.connectionEpoch, '7')
  assert.equal(result.hostConnectionEpoch, '9')
  assert.equal(f.calls(), 2)
})

test('a public intent cannot authenticate another computer or paired server', () => {
  const f = fixture()
  assert.throws(() => validateChatgptPairingState(f.state, { ...f.intent, executorId: randomUUID() }))
  assert.throws(() => validateChatgptPairingState(f.state, { ...f.intent, apiOrigin: 'https://foreign.example' }))
  assert.throws(() => validateChatgptPairingState({ ...f.state, connectionEpoch: undefined }, f.intent))
})

test('first-use preparation canonicalizes real pairing-code raw keys without adopting another public key', () => {
  const f = fixture()
  const der = Buffer.from(f.state.machinePublicKey, 'base64url')
  assert.equal(chatgptPreparationPublicKey({ ...f.state, machinePublicKey: der.subarray(-32).toString('base64url') }),
    f.state.machinePublicKey)
  assert.equal(chatgptPreparationPublicKey(f.state), f.state.machinePublicKey)
  assert.throws(() => chatgptPreparationPublicKey({ ...f.state, machinePublicKey: 'a'.repeat(43) }), /unavailable/u)
})

for (const mutation of ['digest', 'team', 'owner', 'parent_epoch', 'key']) {
  test(`fresh companion authority refuses ${mutation} substitution`, async () => {
    const f = fixture()
    if (mutation === 'digest') f.challenge.digest = '0'.repeat(64)
    if (mutation === 'team') f.challenge.principal.teamId = randomUUID()
    if (mutation === 'owner') f.challenge.principal.ownerSubject = 'different-owner'
    if (mutation === 'parent_epoch') f.challenge.connectionEpoch = '8'
    if (mutation === 'key') f.challenge.publicKeyFingerprint = `sha256:${'0'.repeat(64)}`
    await assert.rejects(renewChatgptProfileAuthority({ ...f, stateDirectory: 'fixture-only',
      readState: async () => f.state }))
    assert.equal(f.calls(), 1)
  })
}

test('a parent reconnect during delegation confirmation fences the old signed context', async () => {
  const f = fixture()
  let reads = 0
  await assert.rejects(renewChatgptProfileAuthority({ ...f, stateDirectory: 'fixture-only', readState: async () =>
    ++reads === 1 ? f.state : { ...f.state, connectionEpoch: '8' } }))
  assert.equal(f.calls(), 2)
})
