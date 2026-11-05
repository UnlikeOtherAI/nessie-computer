import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { type ExecutorChatgptContext, type LocalInferenceSignedEnvelope } from '@nessie/executor-protocol'
import { verifyLocalInferenceEnvelope } from '@nessie/local-inference-host'
import { ChatgptReceiptCustody } from '../src/chatgpt-receipt-custody.js'
import { newChatgptProfileKey } from '../src/chatgpt-profile-key.js'
import { chatgptCompanionFingerprint } from '../src/chatgpt-profile-authority.js'
import { chatgptBytesDigest } from '../src/chatgpt-profile-store.js'
import { ensureOwnerOnlyStateDirectory, secureOwnerOnlyStateFile } from '../src/state-security.js'
import { verifyInferenceTestState } from './fixtures/local-inference-security.js'
import { localResult } from './fixtures/local-inference-host.js'
import type { PersonalReceiptTransport } from '../src/personal-receipt-transport.js'
import type { PersonalStateMutation } from '../src/personal-state-mutation.js'
import { EncryptedLocalInferenceReceiptJournal } from '../src/local-inference-receipts.js'
import { LocalInferenceResultSchema } from '@nessie/executor-protocol'

const security = { platform: 'win32' as const, helper: verifyInferenceTestState }
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-chatgpt-custody-'))
  await ensureOwnerOnlyStateDirectory(root, security)
  const key = newChatgptProfileKey(randomUUID())
  const principal = { serverOrigin: 'https://nessie.example', identityIssuer: 'https://nessie.example',
    organizationId: randomUUID(), teamId: randomUUID(), ownerUserId: randomUUID(), ownerSubject: 'local:fixture' }
  const context: ExecutorChatgptContext = { protocolVersion: 1, nonce: 'n'.repeat(48),
    executorId: randomUUID(), hostId: randomUUID(), profileId: key.profileId, delegationId: randomUUID(),
    role: 'chatgpt', publicKeyFingerprint: chatgptCompanionFingerprint(key), connectionEpoch: '2',
    hostConnectionEpoch: '3', principal, deployment: 'selfHosted', observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString() }
  const source = { kind: 'chatgpt' as const, processing: 'openai_cloud' as const,
    billingSource: 'personal_plan' as const, profileId: key.profileId, accountGeneration: 1, consentRevision: 1 }
  let failAckPublication = false
  let backgroundRevision: number | null = null
  const mutation: PersonalStateMutation = { root, durability: 'process_crash' as const,
    ensureDirectory: async (path: string) => {
      if (path !== root) await mutation.ensureDirectory(dirname(path))
      await ensureOwnerOnlyStateDirectory(path, security)
    },
    barrier: async () => undefined, // CAS fixture only, no native durability claim.
    mutate: async (path: string, operation: {
      operation: 'replace'; bytes: Uint8Array; expectedDigest: string | null
    } | { operation: 'delete'; expectedDigest: string }) => {
      if (failAckPublication && operation.operation === 'replace'
        && path.endsWith('origins.json') && JSON.parse(Buffer.from(operation.bytes).toString('utf8')).records
          .some((record: { resultAckDigest: string | null }) => record.resultAckDigest)) {
        failAckPublication = false
        throw new Error('fixture ACK publication failed')
      }
      const prior = await readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      assert.equal(prior ? chatgptBytesDigest(prior) : null, operation.expectedDigest)
      if (operation.operation === 'delete') await unlink(path)
      else { await writeFile(path, operation.bytes); await secureOwnerOnlyStateFile(path, security) }
    } }
  let allowForget = false
  let failDelivery = false
  const envelopes: LocalInferenceSignedEnvelope[] = []
  const statusEnvelopes: LocalInferenceSignedEnvelope[] = []
  const confirmations: boolean[] = []
  let serverDigest: string | null = null
  let outcomeDeliveries = 0
  const delivered = async (envelope: LocalInferenceSignedEnvelope, body: unknown) => {
    assert.equal(verifyLocalInferenceEnvelope({ envelope, body, machinePublicKey: key.publicKey }).ok, true)
    if (failDelivery) throw new Error('fixture remote offline')
    envelopes.push(envelope)
    return { acknowledged: true as const }
  }
  const create = (current = context) => new ChatgptReceiptCustody({ mutation, context: current, key,
    backgroundConsentRevision: async () => backgroundRevision,
    accountGeneration: 1, consentRevision: 1, security, canForget: async () => allowForget,
    api: { resultReceipt: input => {
      outcomeDeliveries += 1
      return delivered(input.envelope, input.receipt)
    },
      receiptStatus: async input => {
        assert.equal(verifyLocalInferenceEnvelope({ envelope: input.envelope, body: input.receipt,
          machinePublicKey: key.publicKey }).ok, true)
        if (failDelivery) throw new Error('fixture remote offline')
        statusEnvelopes.push(input.envelope)
        return { acknowledged: true as const, resultDigest: serverDigest }
      },
      terminationReceipt: input => {
        confirmations.push(input.termination.confirmed)
        return delivered(input.envelope, input.termination)
      } } })
  const custody = create()
  await custody.open()
  const incoming = (): Parameters<PersonalReceiptTransport['retainAttempt']>[0] => {
    const runId = randomUUID()
    return { dispatchFence: 2,
      host: { hostId: context.hostId, organizationId: principal.organizationId,
        connectionEpoch: '3', executorConnectionEpoch: '2' },
      admission: { admissionId: randomUUID(), resourceId: randomUUID(), fence: randomUUID(), inferenceSource: source },
      attempt: { attemptId: randomUUID(), hostId: context.hostId, hostEpoch: 3, runId,
        runFence: 'run-fence', invocationId: 'invocation', bindingId: randomUUID(), bindingRevision: 1,
        modelName: `chatgpt/${key.profileId}/gpt-6.1-sol`, modelDigest: 'a'.repeat(64), inferenceSource: source,
        personalAuthority: { principal,
          agent: { kind: 'private', id: randomUUID(), ownerUserId: principal.ownerUserId, teamId: principal.teamId },
          origin: { kind: 'interactive', requestingUserId: principal.ownerUserId, rootRunId: runId },
          rootRunId: runId, runId, soleReaderUserId: principal.ownerUserId } } }
  }
  const receipt = (origin: ReturnType<typeof incoming>) => ({ attemptId: origin.attempt.attemptId,
    dispatchFence: origin.dispatchFence, result: { ...localResult(), inferenceSource: source,
      capability: { ...localResult().capability, model: origin.attempt.modelName, provider: 'executor/chatgpt' },
      modelDigest: origin.attempt.modelDigest, usage: { inputTokens: null, outputTokens: null } } })
  return { root, custody, create, context, source, incoming, receipt, envelopes, confirmations,
    background: (revision: number | null) => { backgroundRevision = revision },
    statusEnvelopes, outcomeDeliveries: () => outcomeDeliveries,
    serverAck: (digest: string | null) => { serverDigest = digest },
    failAckPublication: () => { failAckPublication = true },
    journal: (owner = custody) => new EncryptedLocalInferenceReceiptJournal(owner.storage,
      Buffer.from(key.receiptKey, 'base64url'), () => new Date(), { personalCapacity: 4 }),
    forget: () => { allowForget = true }, offline: () => { failDelivery = true },
    clean: () => rm(root, { recursive: true, force: true }) }
}

test('new background origins need current local consent while original receipts survive its withdrawal', async () => {
  const f = await fixture()
  try {
    const origin = f.incoming()
    origin.attempt.personalAuthority.origin = { kind: 'background',
      authorizingUserId: f.context.principal.ownerUserId, automationId: randomUUID(), authorizationRevision: 1,
      rootRunId: origin.attempt.runId, backgroundConsentRevision: 7 }
    await assert.rejects(f.custody.transport.retainAttempt(origin), /custody_unavailable/u)
    f.background(7)
    await f.custody.transport.retainAttempt(origin)
    await f.custody.transport.prepareInvocation({ attemptId: origin.attempt.attemptId,
      dispatchFence: origin.dispatchFence })
    f.background(8)
    await assert.rejects(f.custody.transport.retainAttempt({ ...origin, attempt: { ...origin.attempt,
      attemptId: randomUUID() } }), /custody_unavailable/u)
    await f.custody.transport.result(f.receipt(origin))
    assert.equal(f.envelopes.length, 1)
  } finally { await f.clean() }
})

test('original host epochs survive restart and receipts are freshly signed for the exact original body', async () => {
  const f = await fixture()
  try {
    const origin = f.incoming()
    await f.custody.transport.retainAttempt(origin)
    await f.custody.transport.prepareInvocation({ attemptId: origin.attempt.attemptId,
      dispatchFence: origin.dispatchFence })
    const restarted = f.create({ ...f.context, connectionEpoch: '8', hostConnectionEpoch: '9' })
    await restarted.transport.result(f.receipt(origin))
    await restarted.transport.termination({ ...origin.admission,
      attemptId: origin.attempt.attemptId, confirmed: false })
    assert.deepEqual(f.envelopes.map(value => [value.purpose, value.connectionEpoch, value.executorConnectionEpoch]),
      [['result', '3', '2'], ['termination', '3', '2']])
    assert.equal(f.envelopes[1]!.sequence, f.envelopes[0]!.sequence + 1)
    assert.deepEqual(f.confirmations, [false], 'prepared work retains unknown provider termination')
    assert.equal(await restarted.settled(), false, 'ACK does not replace native outbox absence')
    f.forget()
    assert.equal(await restarted.settled(), true)
    const metadata = await readFile(join(f.custody.directory, 'origins.json'), 'utf8')
    assert.equal(metadata.includes('"resultKnownAck":false'), true, 'unknown usage is never invented')
    assert.equal(metadata.includes('receiptKey'), false)
    assert.equal(metadata.includes('privateKey'), false)
    assert.equal(metadata.includes('messages'), false)
  } finally { await f.clean() }
})

test('server-retained original ACK repairs retired live journals without result or provider replay', async () => {
  const f = await fixture()
  try {
    const origin = f.incoming()
    await f.custody.transport.retainAttempt(origin)
    await f.custody.transport.prepareInvocation({ attemptId: origin.attempt.attemptId,
      dispatchFence: origin.dispatchFence })
    const serverDigest = 'b'.repeat(64)
    f.serverAck(serverDigest)
    const restarted = f.create({ ...f.context, connectionEpoch: '8', hostConnectionEpoch: '9' })
    await restarted.reconcileAcknowledgements()
    assert.equal(f.statusEnvelopes.length, 0, 'pending native work refuses retrospective clearance')
    f.forget()
    f.failAckPublication()
    await assert.rejects(restarted.reconcileAcknowledgements(), /ACK publication failed/u)
    assert.equal(await restarted.settled(), false, 'a server read cannot replace local durable publication')
    await restarted.reconcileAcknowledgements()
    assert.equal(f.outcomeDeliveries(), 0, 'status authentication never submits a synthetic outcome')
    assert.deepEqual(f.confirmations, [false], 'prepared work does not invent provider termination')
    assert.deepEqual(f.statusEnvelopes.map(value => [value.connectionEpoch, value.executorConnectionEpoch]),
      [['3', '2'], ['3', '2']])
    const stored = JSON.parse(await readFile(join(f.custody.directory, 'origins.json'), 'utf8'))
    assert.equal(stored.records[0].resultAckDigest, serverDigest)
    assert.equal(stored.records[0].resultKnownAck, false, 'no usage inferred from a stored digest')
    assert.equal(await restarted.settled(), true)
  } finally { await f.clean() }
})

test('missing server outcome or failed status delivery retains original custody', async () => {
  const f = await fixture()
  try {
    const origin = f.incoming()
    await f.custody.transport.retainAttempt(origin)
    await f.custody.transport.prepareInvocation({ attemptId: origin.attempt.attemptId,
      dispatchFence: origin.dispatchFence })
    f.forget()
    await f.custody.reconcileAcknowledgements()
    assert.equal(await f.custody.settled(), false)
    assert.deepEqual(f.confirmations, [])
    f.serverAck('c'.repeat(64))
    f.offline()
    await assert.rejects(f.custody.reconcileAcknowledgements(), /remote offline/u)
    assert.equal(await f.custody.settled(), false)
    assert.equal(f.outcomeDeliveries(), 0)
  } finally { await f.clean() }
})

for (const prepared of [false, true]) {
  test(`encrypted reserved-only restart reconstructs ${prepared ? 'unknown' : 'not_sent'} without provider replay`,
    async () => {
      const f = await fixture()
      try {
        const origin = f.incoming()
        await f.custody.transport.retainAttempt(origin)
        const first = f.journal()
        await first.reservePersonalAttempt({ attemptId: origin.attempt.attemptId,
          dispatchFence: origin.dispatchFence, inferenceSource: f.source })
        if (prepared) await f.custody.transport.prepareInvocation({ attemptId: origin.attempt.attemptId,
          dispatchFence: origin.dispatchFence })
        // New objects have no prior cached journal state; ciphertext and origin
        // CAS are real fixture files. Kernel actor clearance is tested by the
        // separately installed SIGKILL journey, not asserted by this fixture.
        const restarted = f.create({ ...f.context, hostConnectionEpoch: '9', connectionEpoch: '8' })
        const journal = f.journal(restarted)
        assert.equal((await journal.pending()).length, 0, 'reservation alone is not a completed result')
        assert.equal(await journal.hasPendingAttempt(origin.attempt.attemptId), true)
        const reservations = await journal.pendingReservations()
        assert.equal(reservations.length, 1)
        const recovered = await restarted.recoveryReceipt(reservations[0]!)
        LocalInferenceResultSchema.parse(recovered.result)
        assert.equal(recovered.result.personalNonacceptance?.kind, prepared ? undefined : 'not_sent')
        assert.deepEqual(recovered.result.usage, { inputTokens: null, outputTokens: null })
        assert.equal(recovered.result.content, null)
        await journal.record(recovered)
        await restarted.transport.result(recovered)
        await journal.acknowledge(recovered)
        await restarted.transport.termination({ ...origin.admission, attemptId: origin.attempt.attemptId,
          confirmed: false })
        assert.equal(f.confirmations[0], !prepared)
        assert.equal(await journal.hasPendingAttempt(origin.attempt.attemptId), false)
        if (!prepared) await assert.rejects(restarted.transport.prepareInvocation({
          attemptId: origin.attempt.attemptId, dispatchFence: origin.dispatchFence,
        }), /receipt_custody_unavailable/u)
        f.forget()
        assert.equal(await restarted.settled(), true)
      } finally { await f.clean() }
    })
}

test('four unresolved origins reserve outcome capacity, and the fifth is refused without eviction', async () => {
  const f = await fixture()
  try {
    const originals = Array.from({ length: 4 }, f.incoming)
    for (const origin of originals) await f.custody.transport.retainAttempt(origin)
    await f.custody.transport.retainAttempt(originals[0]!)
    await assert.rejects(f.custody.transport.retainAttempt(f.incoming()), /receipt_custody_unavailable/u)
    assert.equal(JSON.parse(await readFile(join(f.custody.directory, 'origins.json'), 'utf8')).records.length, 4)
    assert.equal(f.envelopes.length, 0)
  } finally { await f.clean() }
})

test('source/admission substitution and an unacknowledged delivery cannot mark local clearance', async () => {
  const f = await fixture()
  try {
    const origin = f.incoming()
    await assert.rejects(f.custody.transport.retainAttempt({ ...origin,
      admission: { ...origin.admission, inferenceSource: { ...f.source, consentRevision: 2 } } }))
    await f.custody.transport.retainAttempt(origin)
    await assert.rejects(f.custody.transport.termination({ ...origin.admission, fence: randomUUID(),
      attemptId: origin.attempt.attemptId, confirmed: true }))
    f.offline()
    await assert.rejects(f.custody.transport.result(f.receipt(origin)), /remote offline/u)
    f.forget()
    assert.equal(await f.custody.settled(), false)
    assert.equal(f.envelopes.length, 0)
  } finally { await f.clean() }
})
