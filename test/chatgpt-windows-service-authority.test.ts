import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import test from 'node:test'
import { canonicalExecutorJson, canonicalExecutorPayload } from '@nessie/executor-protocol'
import { WindowsServiceChatgptAuthority, windowsServiceReference, windowsServiceExecutorId,
  requireChatgptServiceAuthority, type WindowsServiceOperation } from '../src/chatgpt-windows-service-authority.js'
import { chatgptCompanionFingerprint } from '../src/chatgpt-companion-proof.js'
import { ChatgptProfileRecordSchema } from '../src/chatgpt-profile-records.js'
import { readChatgptPairingReference, matchingChatgptPairing, prepareChatgptPairingPrincipal,
  renewChatgptProfileAuthority } from '../src/chatgpt-profile-authority.js'
import { disconnectChatgptDelegation } from '../src/chatgpt-profile-disconnect.js'

test('Windows personal authority refuses user-local state before any machine-key read', () => {
  for (const reference of ['C:\\Users\\owner\\.nessie', 'fixture-only', '']) {
    assert.throws(() => requireChatgptServiceAuthority(reference, 'win32'), /unavailable/u)
  }
  assert.doesNotThrow(() => requireChatgptServiceAuthority(windowsServiceReference(randomUUID()), 'win32'))
  assert.doesNotThrow(() => requireChatgptServiceAuthority('/home/owner/.nessie', 'linux'))
})

const fixture = () => {
  const companion = generateKeyPairSync('ed25519')
  const key = { publicKey: companion.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    privateKey: companion.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') }
  const intent = { version: 1 as const, kind: 'personal-chatgpt-connect' as const, apiOrigin: 'https://nessie.example',
    executorId: randomUUID(), organizationId: randomUUID(), teamId: randomUUID(), profileId: randomUUID() }
  const pairing = { kind: 'windows-service', executorId: intent.executorId, apiBaseUrl: intent.apiOrigin,
    connectionEpoch: '7', machinePublicKeyFingerprint: `sha256:${'d'.repeat(64)}` }
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
  const body = { challengeId: randomUUID(), nonce: 'n'.repeat(48), executorId: intent.executorId,
    profileId: intent.profileId, connectionEpoch: '7', role: 'chatgpt',
    publicKeyFingerprint: chatgptCompanionFingerprint(key),
    principal, deployment: 'selfHosted', expiresAt: new Date(now() + 60_000).toISOString() }
  const challenge = { ...body, digest: createHash('sha256').update(canonicalExecutorJson(body)).digest('hex') }
  const calls: WindowsServiceOperation[] = []
  let reads = 0
  let changePairingAfter = Infinity
  let responseMutation: (value: Record<string, unknown>) => void = () => undefined
  const transport = async (executorId: string, operation: WindowsServiceOperation): Promise<unknown> => {
    assert.equal(executorId, intent.executorId)
    calls.push(operation)
    if (operation.operation === 'pairing') {
      return ++reads > changePairingAfter ? { ...pairing, connectionEpoch: '8' } : pairing
    }
    if (operation.operation === 'scope' || operation.operation === 'prepare') return { pairing, challenge }
    if (operation.operation === 'disconnect') return { pairing, disconnected: true }
    assert.equal(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.personal-host.prove.v1', {
      challengeId: challenge.challengeId, digest: challenge.digest,
    })), companion.publicKey, Buffer.from(operation.companionSignature, 'base64url')), true)
    const context: Record<string, unknown> = { protocolVersion: 1, nonce: operation.nonce,
      executorId: intent.executorId, hostId: randomUUID(), hostConnectionEpoch: '9', delegationId: randomUUID(),
      profileId: intent.profileId, role: 'chatgpt',
      publicKeyFingerprint: challenge.publicKeyFingerprint, connectionEpoch: '7', principal, deployment: 'selfHosted',
      observedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 900_000).toISOString() }
    responseMutation(context)
    return { pairing, context }
  }
  const client = new WindowsServiceChatgptAuthority(windowsServiceReference(intent.executorId), { transport, now })
  return { client, intent, profile, key, challenge, calls, pairing, transport, now,
    changeAfter: (value: number) => { changePairingAfter = value },
    mutateContext: (value: typeof responseMutation) => { responseMutation = value } }
}

test('every Windows public authority entry refuses a local pairing before loading its nonexistent store', {
  skip: process.platform !== 'win32',
}, async () => {
  const f = fixture()
  const reference = 'C:\\nonexistent-fixture-pairing'
  const refused = /chatgpt_owner_authority_unavailable/u
  await assert.rejects(readChatgptPairingReference(reference), refused)
  await assert.rejects(matchingChatgptPairing(reference, f.intent), refused)
  await assert.rejects(prepareChatgptPairingPrincipal(reference, f.profile.profileId), refused)
  await assert.rejects(renewChatgptProfileAuthority({ ...f, stateDirectory: reference }), refused)
  await assert.rejects(disconnectChatgptDelegation(reference, f.profile), refused)
})

test('service delegation uses the interactive companion proof and public pairing only', async () => {
  const f = fixture()
  const context = await f.client.renew(f)
  assert.equal(context.hostConnectionEpoch, '9')
  assert.equal(context.connectionEpoch, '7')
  assert.deepEqual(f.calls.map(call => call.operation), ['pairing', 'prepare', 'pairing', 'confirm', 'pairing'])
  const wire = JSON.stringify(f.calls)
  assert.equal(wire.includes(f.key.privateKey), false)
  assert.equal(wire.includes('machinePrivateKey'), false)
})

for (const mutation of ['source', 'fingerprint', 'epoch', 'owner', 'digest']) {
  test(`service challenge refuses ${mutation} substitution before companion proof`, async () => {
    const f = fixture()
    if (mutation === 'source') f.challenge.principal.teamId = randomUUID()
    if (mutation === 'fingerprint') f.challenge.publicKeyFingerprint = `sha256:${'0'.repeat(64)}`
    if (mutation === 'epoch') f.challenge.connectionEpoch = '8'
    if (mutation === 'owner') f.challenge.principal.ownerSubject = 'foreign'
    if (mutation === 'digest') f.challenge.digest = '0'.repeat(64)
    else {
      const body: Record<string, unknown> = { ...f.challenge }
      delete body.digest
      f.challenge.digest = createHash('sha256').update(canonicalExecutorJson(body)).digest('hex')
    }
    await assert.rejects(f.client.renew(f))
    assert.equal(f.calls.some(call => call.operation === 'confirm'), false)
  })
}
for (const mutation of ['nonce', 'fingerprint', 'epoch', 'source']) {
  test(`service confirmation refuses ${mutation} substitution`, async () => {
    const f = fixture()
    f.mutateContext(context => {
      if (mutation === 'nonce') context.nonce = 'x'.repeat(48)
      if (mutation === 'fingerprint') context.publicKeyFingerprint = `sha256:${'0'.repeat(64)}`
      if (mutation === 'epoch') context.connectionEpoch = '8'
      if (mutation === 'source') context.profileId = randomUUID()
    })
    await assert.rejects(f.client.renew(f))
  })
}
test('pairing is reread before proof and after delegation, never adopted after replacement', async () => {
  for (const changedAfter of [1, 2]) {
    const f = fixture(); f.changeAfter(changedAfter)
    await assert.rejects(f.client.renew(f))
    assert.equal(f.calls.some(call => call.operation === 'confirm'), changedAfter === 2)
  }
})
test('service refusal has no fallback key authority and disconnect preserves exact source', async () => {
  const f = fixture()
  const client = new WindowsServiceChatgptAuthority(windowsServiceReference(f.intent.executorId), {
    transport: async () => { throw new Error('service unavailable') },
  })
  await assert.rejects(client.renew(f), /service unavailable/u)
  await f.client.disconnect(f.profile)
  assert.deepEqual(f.calls.find(call => call.operation === 'disconnect'), { operation: 'disconnect',
    profileId: f.profile.profileId, serverOrigin: f.profile.apiOrigin,
    organizationId: f.profile.organizationId, teamId: f.profile.teamId })
})
test('service reference is structural and public pairing cannot smuggle machine material', async () => {
  const f = fixture()
  assert.equal(windowsServiceExecutorId('/local/paired/state'), null)
  assert.throws(() => windowsServiceExecutorId('windows-service:../state'))
  const client = new WindowsServiceChatgptAuthority(windowsServiceReference(f.intent.executorId), {
    transport: async () => ({ ...f.pairing, machinePrivateKey: 'forged' }),
  })
  await assert.rejects(client.read())
})
