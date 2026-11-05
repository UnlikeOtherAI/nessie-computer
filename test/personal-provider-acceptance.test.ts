import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { LocalInferenceAttemptRequestSchema, type LocalInferenceAttemptControlState,
  type LocalInferenceTermination } from '@nessie/executor-protocol'
import { LocalInferenceHostLoop, type PersonalReceiptTransport } from '../src/local-inference-host.js'
import { createChatgptBackend } from '../src/chatgpt-backend.js'
import { EncryptedLocalInferenceReceiptJournal } from '../src/local-inference-receipts.js'
import { CHATGPT_MODELS_URL } from '../src/chatgpt-http.js'
import {
  apiFor, attempt, machineKeys, receiptJournal, ADMISSION, HOST_ID, ORG_ID,
} from './fixtures/local-inference-host.js'

const personalSource = () => ({ kind: 'chatgpt' as const, processing: 'openai_cloud' as const,
  billingSource: 'personal_plan' as const, profileId: randomUUID(), accountGeneration: 1, consentRevision: 1 })

const fixture = async (accept: () => Promise<{ state: LocalInferenceAttemptControlState }>,
  receipts: Partial<PersonalReceiptTransport> = {},
  options: { source?: ReturnType<typeof personalSource>; journal?: EncryptedLocalInferenceReceiptJournal } = {}) => {
  const source = options.source ?? personalSource()
  let posts = 0
  const backend = createChatgptBackend({ listReadyProfiles: async () => [source],
    acquireAccess: async input => ({ accessToken: 'fixture-only-token', signal: input.signal,
      release: async () => undefined }) }, { fetchImpl: async url => {
    if (url === CHATGPT_MODELS_URL) return Response.json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] })
    posts++
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
      id: 'response', model: 'gpt-6.1-sol', status: 'completed', output: [{ id: 'message', type: 'message',
        role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }],
      usage: { input_tokens: 2, output_tokens: 1 },
    } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  } })
  const model = (await backend.observe())[0]!
  const call = { ...attempt(), attemptId: randomUUID(), runId: randomUUID() }
  delete call.maxOutputTokens
  const request = LocalInferenceAttemptRequestSchema.parse({ ...call, modelName: model.name,
    modelDigest: model.manifestDigest, inferenceSource: source,
    personalAuthority: { runId: call.runId, rootRunId: call.runId, soleReaderUserId: 'owner',
      principal: { serverOrigin: 'https://nessie.example', identityIssuer: 'https://identity.example',
        organizationId: ORG_ID, teamId: 'team', ownerUserId: 'owner', ownerSubject: 'subject' },
      agent: { kind: 'private', id: 'agent', ownerUserId: 'owner', teamId: 'team' },
      origin: { kind: 'interactive', requestingUserId: 'owner', rootRunId: call.runId } } })
  const { api, calls } = apiFor(request)
  api.accept = accept
  api.claim = async () => ({ admission: { ...ADMISSION, inferenceSource: source }, attempt: request, dispatchFence: 1 })
  const keys = machineKeys(), journal = options.journal ?? receiptJournal().journal
  const coordinator = { inferenceSource: source, identity: keys,
      control: async () => ({ capacity: 1, controlRevision: 1, paused: false, resourceId: ADMISSION.resourceId,
        pendingAction: null }), syncControl: async () => undefined, healthReason: async () => null,
      flushTerminations: async (_submit: (termination: LocalInferenceTermination) => Promise<void>) => undefined,
      acquire: async () => ({ requestId: randomUUID(),
        abandonPoll: async () => undefined, bind: async () => undefined,
        finish: async () => undefined, releaseIdle: async () => undefined }) }
  const loop = new LocalInferenceHostLoop({ backend, transport: api,
    personalReceipts: { retainAttempt: async () => undefined, prepareInvocation: async () => undefined,
      result: api.result, termination: api.terminate, ...receipts },
    identity: { hostId: HOST_ID, organizationId: ORG_ID, connectionEpoch: '1',
      executorConnectionEpoch: '1', machinePrivateKey: keys.privateKey },
    isPaused: () => false, journal, origin: 'unused', onFailure: () => undefined,
    coordinator,
  })
  return { loop, calls, api, journal, coordinator, source, get posts() { return posts } }
}

test('personal provider POST waits for successful durable acceptance ACK', { timeout: 10_000 }, async (t) => {
  let resolve!: (value: { state: LocalInferenceAttemptControlState }) => void
  let called!: () => void
  const entered = new Promise<void>(r => { called = r })
  const ack = new Promise<{ state: LocalInferenceAttemptControlState }>(r => { resolve = r })
  const f = await fixture(async () => { called(); return ack })
  const completion = f.loop.pollOnce()
  t.after(() => { resolve({ state: 'cancelled' }); f.loop.stop() })
  await Promise.race([entered, completion.then(outcome => {
    assert.fail(`Host completed before durable acceptance: ${JSON.stringify(outcome)}`)
  })])
  assert.equal(f.posts, 0)
  resolve({ state: 'active' })
  await completion
  assert.equal(f.posts, 1)
  assert.equal(f.calls.results[0]?.receipt.result.capability.provider, 'executor/chatgpt')
})

for (const kind of ['failed', 'lost', 'fenced'] as const) test(`${kind} accept ACK prevents POST`,
  { timeout: 10_000 }, async () => {
  const f = await fixture(async () => {
    if (kind === 'fenced') return { state: 'cancelled' }
    throw new Error(kind === 'lost' ? 'Server committed but ACK disappeared' : 'Accept failed before commit')
  })
  await f.loop.pollOnce()
  assert.equal(f.posts, 0)
  assert.deepEqual(f.calls.results[0]?.receipt.result.personalNonacceptance, { kind: 'not_sent' })
})


test('protected original receipt custody failure prevents acceptance and provider POST',
  { timeout: 10_000 }, async () => {
  let accepts = 0
  const f = await fixture(async () => { accepts++; return { state: 'active' } }, {
    retainAttempt: async ({ attempt: retained, host }) => {
      assert.equal('messages' in retained, false)
      assert.equal('tools' in retained, false)
      assert.equal('machinePrivateKey' in host, false)
      assert.equal(host.executorConnectionEpoch, '1')
      throw new Error('Protected origin admission unavailable')
    },
  })
  await f.loop.pollOnce()
  assert.equal(accepts, 0)
  assert.equal(f.posts, 0)
  assert.deepEqual(f.calls.results[0]?.receipt.result.personalNonacceptance, { kind: 'not_sent' })
})

test('stopped host reconciles failed live receipts through historical transport without provider replay',
  { timeout: 10_000 }, async () => {
    let permitAck = false, historical = 0
    const f = await fixture(async () => ({ state: 'active' }), {
      result: async receipt => {
        historical++
        assert.equal(receipt.result.inferenceSource?.kind, 'chatgpt')
        if (!permitAck) throw new Error('Original receipt endpoint temporarily unavailable')
        return { acknowledged: true }
      },
    })
    f.api.result = async () => { throw new Error('Live delegated epoch no longer authorized') }
    await f.loop.pollOnce()
    assert.equal(f.posts, 1)
    assert.equal((await f.journal.pending()).length, 1)
    f.loop.stop()
    await f.loop.reconcileReceipts()
    assert.equal((await f.journal.pending()).length, 1)
    permitAck = true
    await f.loop.pollOnce()
    assert.deepEqual(await f.journal.pending(), [])
    assert.equal(f.posts, 1)
    assert.equal(historical, 3)
  })


test('near-full concurrent hosts refuse before accept and dispose without evicting older liability',
  { timeout: 10_000 }, async t => {
  let encrypted: { ciphertext: string; iv: string; tag: string; version: 1 } | undefined
  const storage = { read: async () => encrypted, write: async (value: NonNullable<typeof encrypted>) => {
    encrypted = value
  }, remove: async () => { encrypted = undefined } }
  const key = new Uint8Array(32).fill(1), source = personalSource()
  const journal = new EncryptedLocalInferenceReceiptJournal(storage, key, () => new Date(), { personalCapacity: 4 })
  const older = Array.from({ length: 3 }, () => randomUUID())
  for (const attemptId of older) await journal.reservePersonalAttempt({ attemptId, dispatchFence: 1,
    inferenceSource: source })
  let accepts = 0, retained = 0
  let release!: (value: { state: LocalInferenceAttemptControlState }) => void
  const ack = new Promise<{ state: LocalInferenceAttemptControlState }>(resolve => { release = resolve })
  const accept = async () => { accepts++; return ack }
  const receipts = { retainAttempt: async ({ admission }: Parameters<PersonalReceiptTransport['retainAttempt']>[0]) => {
    assert.equal(admission.resourceId, ADMISSION.resourceId)
    retained++
  } }
  const first = await fixture(accept, receipts, { source, journal })
  const second = await fixture(accept, receipts, { source, journal })
  t.after(() => { release({ state: 'cancelled' }); first.loop.stop(); second.loop.stop() })
  const completions = [first.loop.pollOnce(), second.loop.pollOnce()]
  await Promise.race(completions)
  assert.equal(accepts, 1)
  assert.equal(retained, 2)
  assert.equal(first.posts + second.posts, 0)
  const refused = [...first.calls.results, ...second.calls.results]
  assert.equal(refused.length, 1)
  assert.deepEqual(refused[0]?.receipt.result.personalNonacceptance, { kind: 'not_sent' })
  release({ state: 'active' })
  await Promise.all(completions)
  assert.equal(first.posts + second.posts, 1)
  const restart = new EncryptedLocalInferenceReceiptJournal(storage, key, () => new Date(), { personalCapacity: 4 })
  for (const id of older) assert.equal(await restart.hasPendingAttempt(id), true)
  assert.deepEqual(await restart.pending(), [])
  let nextAccepts = 0
  const next = await fixture(async () => { nextAccepts++; return { state: 'active' } }, receipts,
    { source, journal: restart })
  await next.loop.pollOnce()
  assert.equal(nextAccepts, 1)
  assert.equal(next.posts, 1)
})


test('personal provider entry waits for durable invocation marker after acceptance', { timeout: 10_000 }, async t => {
  let accepts = 0
  let entered!: () => void, release!: () => void
  const markerEntered = new Promise<void>(resolve => { entered = resolve })
  const markerAck = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async () => { accepts++; return { state: 'active' } }, {
    prepareInvocation: async () => { entered(); await markerAck },
  })
  t.after(() => { release(); f.loop.stop() })
  const completion = f.loop.pollOnce()
  await Promise.race([markerEntered, completion.then(() => { throw new Error('Host skipped marker') })])
  assert.equal(accepts, 1)
  assert.equal(f.posts, 0)
  assert.equal((await f.journal.pendingReservations()).length, 1)
  release()
  await completion
  assert.equal(f.posts, 1)
  assert.deepEqual(await f.journal.pendingReservations(), [])
})


test('failed invocation marker never enters the provider after durable acceptance', async () => {
  let accepts = 0
  const f = await fixture(async () => { accepts++; return { state: 'active' } }, {
    prepareInvocation: async () => { throw new Error('Native marker outcome unknown') },
  })
  await f.loop.pollOnce()
  assert.equal(accepts, 1)
  assert.equal(f.posts, 0)
  assert.deepEqual(f.calls.results[0]?.receipt.result.personalNonacceptance, { kind: 'not_sent' })
})


test('live personal result ACK always records original custody before encrypted outcome cleanup', async () => {
  let originalCalls = 0
  const f = await fixture(async () => ({ state: 'active' }), {
    result: async receipt => {
      originalCalls++
      assert.equal(receipt.result.finishReason, 'stop')
      return { acknowledged: true }
    },
  })
  f.api.result = async () => { throw new Error('Personal result must not bypass original custody over live socket') }
  await f.loop.pollOnce()
  assert.equal(f.posts, 1)
  assert.equal(originalCalls, 1)
  assert.deepEqual(await f.journal.pending(), [])
  assert.equal(f.calls.results.length, 0)
})


test('personal termination ACK records original custody before intent cleanup, without live socket bypass',
  async () => {
  let pending = true, fail = true, originalCalls = 0
  const f = await fixture(async () => ({ state: 'active' }), { termination: async value => {
    originalCalls++
    assert.equal(value.confirmed, false)
    if (fail) throw new Error('Original custody ACK not committed')
    return { acknowledged: true }
  } })
  f.api.terminate = async () => { throw new Error('Personal termination reached live socket') }
  f.coordinator.flushTerminations = async submit => {
    if (!pending) return
    await submit({ inferenceSource: f.source, attemptId: randomUUID(), admissionId: ADMISSION.admissionId,
      resourceId: ADMISSION.resourceId, fence: ADMISSION.fence, confirmed: false })
    pending = false
  }
  await f.loop.reconcileReceipts()
  assert.equal(pending, true)
  fail = false
  await f.loop.reconcileReceipts()
  assert.equal(pending, false)
  assert.equal(originalCalls, 2)
  assert.equal(f.posts, 0)
})
