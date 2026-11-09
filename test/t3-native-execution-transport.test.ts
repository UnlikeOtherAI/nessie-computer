import assert from 'node:assert/strict'
import { T3ExecutionShutdownPreparationPayloadSchema, T3_EXECUTION_SHUTDOWN_SLOT_DOMAIN,
  T3_EXECUTION_SHUTDOWN_PREPARATION_DOMAIN } from '@nessie/executor-protocol/t3-session'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { canonicalExecutorJson, canonicalExecutorPayload } from '@nessie/executor-protocol'
import { decodeExecutorT3LaneOperation, encodeExecutorT3LaneOperation, T3_SOURCE_COMMIT,
  T3_EXECUTION_GRAPH_DOMAIN, T3_EXECUTION_FRAME_PREPARATION_DOMAIN, T3_EXECUTION_RESERVATION_DOMAIN,
  T3_EXECUTION_SECRET_READ_PREPARATION_DOMAIN,
  T3_EXECUTION_ASSOCIATION_DOMAIN, T3_EFFECT_SIGNATURE_DOMAIN, T3NativeExecutionIntakeSchema,
  T3_EXECUTION_PRECLAIM_PREPARATION_DOMAIN, T3_EXECUTION_PRECLAIM_ID_DOMAIN,
  T3ExecutionPreclaimPreparationPayloadSchema,
  T3ExecutionLegacyShellPreparationPayloadSchema, T3_EXECUTION_LEGACY_SHELL_PREPARATION_DOMAIN,
  T3_EXECUTION_LEGACY_SHELL_SLOT_DOMAIN,
  T3NativeExecutionOperationSchema,
  type T3ExecutionReceipt, type T3NativeExecutionOperationIntake,
} from '@nessie/executor-protocol/t3-session'
import { createExecutorApi, executorApi } from '../src/api-client.js'
import { createT3NativeExecutionTransport } from '../src/t3-native-execution-transport.js'
import type { ExecutorLocalState } from '../src/state-store.js'

// Transport-only fixtures. Synthetic envelopes never establish native authority;
// the service must independently verify the backend signature at actual use.
const hash = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex')
function fixture() {
  const key = generateKeyPairSync('ed25519')
  const request = decodeExecutorT3LaneOperation({ transportVersion: 1, protocolVersion: 2,
    sourceRevision: T3_SOURCE_COMMIT, executorId: '11111111-1111-4111-8111-111111111111',
    environmentId: 'source:原文', connectionEpoch: '1', runtimeGeneration: 'writer:one',
    correlationId: 'attempt:one', relayOrdinal: 0, kind: 'request', method: 'orchestration.launchThread',
    commandId: 'command:one', input: { commandId: 'command:one', projectId: 'project:one', threadId: 'thread:one',
      title: 'Původní vlákno', modelSelection: { instanceId: 'codex', model: 'fixture-model' },
      runtimeMode: 'full-access', interactionMode: 'default', workspaceStrategy: { type: 'root' },
      initialMessage: { messageId: 'message:one', text: 'spusť původní příkaz', attachments: [] } } })
  const binding = { executorId: request.executorId, environmentId: request.environmentId,
    threadId: 'thread:one', providerInstanceId: 'codex', connectionEpoch: '1', runtimeGeneration: 'writer:one',
    correlationId: request.correlationId, commandId: 'command:one',
    requestSha256: hash(JSON.stringify(encodeExecutorT3LaneOperation(request))),
    relayHmac: 'hmac-sha256:' + 'a'.repeat(64), actorReference: hash('actor'), initiationReference: hash('origin'),
    sourceRootKey: 'physical:one', sourceGeneration: 'capture:one', driver: 'codex' as const,
    continuationHomeKey: 'continuation:one', historyHomeKey: 'history:one', credentialBindingId: 'c'.repeat(64) }
  const generation = { pid: 1, startedAt: 'start', bootId: 'boot' }
  const custody = { service: generation, controller: generation, supervisor: generation, runtime: generation,
    jobName: 'Global\\NessieCustody-' + '1'.repeat(64),
    releaseDigest: '2'.repeat(64), serviceImageDigest: '3'.repeat(64) }
  const now = Date.now(), reservationId = '4'.repeat(64), graphId = '5'.repeat(64)
  const receipt = (domain: T3ExecutionReceipt['domain'], payload: unknown): T3ExecutionReceipt => ({
    domain, payload: JSON.stringify(payload), keyId: '6'.repeat(64), signature: 'a'.repeat(86) })
  const delivery = { requestDigest: binding.relayHmac, executionGraph: receipt(T3_EXECUTION_GRAPH_DOMAIN,
    { version: 1, nonce: '7'.repeat(64), binding, sourceRevision: T3_SOURCE_COMMIT, targets: [], custody,
      issuedAtMs: now, expiresAtMs: now + 5000 }) }
  const state = { apiBaseUrl: 'https://api.example.test', executorId: request.executorId, connectionEpoch: '1',
    machinePrivateKey: key.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    machinePublicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  } as ExecutorLocalState
  const admission = { version: 1, phase: 'reserve', binding: {
    ...binding, sourceEvidenceDigest: hash(delivery.executionGraph.payload) },
    reservationId, issuerKeyId: '6'.repeat(64), releaseDigest: custody.releaseDigest, nonce: '8'.repeat(64),
    issuedAtMs: now, expiresAtMs: now + 5000 }
  const signed = (payload: unknown) => ({ payload: JSON.stringify(payload, null, 2),
    keyId: 'backend', signature: 'abc' })
  const controller = new AbortController()
  return { request, delivery, state, admission, signed, key, graphId, reservationId, controller, receipt, custody,
    signal: controller.signal, generation }
}

// Unverified metadata for refusal/transport checks only. No native producer,
// tool process, enrolled proof, read, value or positive authority is simulated.
function secretReadFixture() {
  const f = fixture(), issuedAtMs = Date.now() - 1000
  const observed = { version: 1, action: 'selected-provider-secret-read', binding: f.admission.binding,
    acceptedGraphNonce: '7'.repeat(64), planId: 'd'.repeat(64), planDigest: hash('plan'), readId: 'e'.repeat(64),
    evidence: { resourceId: 'f'.repeat(64), resourceGeneration: hash('resource'), settingsIdentity: 'held-settings',
      settingsDigest: '0'.repeat(64), providerInstanceId: 'codex', providerConfigDigest: hash('config'),
      secretProvidersDigest: hash('providers'), credentialHomeReferenceId: f.admission.binding.credentialBindingId,
      custody: f.custody },
    slot: { index: 0, name: 'FIXTURE_SLOT',
      reference: { provider: 'one_password', reference: 'op://Fixture/Item/field' } },
    recipient: { slotId: '1'.repeat(64), generation: f.generation },
    tool: { kind: 'one_password', installationDigest: hash('installation'), imageDigest: hash('tool'), version: '1',
      account: 'fixture.test', ownerProfileIdentity: 'fixture-owner', environmentDigest: hash('environment'),
      processDescriptorDigest: hash('process') },
    maxValueBytes: 65536, nonce: 'e'.repeat(64), issuedAtMs, expiresAtMs: issuedAtMs + 5000 }
  const preparationReceipt = f.receipt(T3_EXECUTION_SECRET_READ_PREPARATION_DOMAIN, observed)
  preparationReceipt.payload = JSON.stringify(observed, null, 2)
  const candidate = { ...observed, issuerKeyId: preparationReceipt.keyId,
    preparationReceiptDigest: hash(preparationReceipt.payload), nonce: '2'.repeat(64), issuedAtMs: Date.now() }
  return { ...f, observed, preparationReceipt, candidate }
}

function preclaimFixture() {
  const f = fixture(), issuedAtMs = Date.now() - 500
  const raw = T3ExecutionPreclaimPreparationPayloadSchema.parse(JSON.parse(readFileSync(new URL(
    './t3-session-runtime/fixtures/execution-preclaim.json', import.meta.url), 'utf8')).preparation)
  const binding = f.admission.binding
  const claimId = hash(canonicalExecutorJson({ domain: T3_EXECUTION_PRECLAIM_ID_DOMAIN,
    executorId: binding.executorId, sourceEvidenceDigest: binding.sourceEvidenceDigest,
    acceptedGraphNonce: '7'.repeat(64), effectId: raw.bound.observation.effectId,
    attemptCount: raw.bound.observation.attemptCount })).slice(7)
  const observed = { ...raw, binding, acceptedGraphNonce: '7'.repeat(64), claimId, nonce: claimId,
    evidence: { ...raw.evidence, custody: f.custody }, issuedAtMs, expiresAtMs: issuedAtMs + 5000,
    bound: { observation: { ...raw.bound.observation, threadId: binding.threadId, observedAtMs: issuedAtMs },
      original: { ...raw.bound.original, parentCommandId: binding.commandId, threadId: binding.threadId,
        providerInstanceId: binding.providerInstanceId, messageId: 'message:one' } } }
  const preparationReceipt = f.receipt(T3_EXECUTION_PRECLAIM_PREPARATION_DOMAIN, observed)
  preparationReceipt.payload = JSON.stringify(observed, null, 2)
  const candidate = { ...observed, issuerKeyId: preparationReceipt.keyId,
    preparationReceiptDigest: hash(preparationReceipt.payload), nonce: '0'.repeat(64), issuedAtMs: Date.now() }
  return { ...f, observed, preparationReceipt, candidate }
}

test('preclaim HTTP preserves exact row/lineage bytes and refuses changed evidence or renewed expiry', async () => {
  for (const mode of ['exact', 'row', 'lineage', 'receipt', 'expiry', 'epoch', 'abort']) {
    const f = preclaimFixture(), candidate = structuredClone(f.candidate)
    if (mode === 'row') candidate.bound.observation.rowDigest = hash('replacement')
    if (mode === 'lineage') candidate.bound.original.runId = 'replacement'
    if (mode === 'receipt') candidate.preparationReceiptDigest = hash('replacement')
    if (mode === 'expiry') candidate.expiresAtMs++
    const answer = f.signed(candidate)
    let calls = 0
    const api = createExecutorApi({ fetchImpl: async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body)) as T3NativeExecutionOperationIntake
      assert.equal(body.operation, 'execution.preclaim')
      if (body.operation !== 'execution.preclaim') assert.fail('wrong operation')
      assert.equal(body.input.preparationReceipt.payload, f.preparationReceipt.payload)
      assert.equal(init?.redirect, 'error')
      if (mode === 'epoch') f.state = { ...f.state, connectionEpoch: '2' }
      if (mode === 'abort') f.controller.abort()
      return new Response(JSON.stringify({ data: answer }))
    } })
    const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
    const work = port.preclaim({ preparationReceipt: f.preparationReceipt }, f.signal)
    if (mode === 'exact') assert.deepEqual(await work, answer)
    else await assert.rejects(work)
    assert.equal(calls, 1, 'uncertain admission must not retry HTTP')
  }
})

test('whole shell HTTP preserves all observed targets and refuses altered evidence, expiry or epoch without retry', async () => {
  for (const mode of ['exact', 'targets', 'source', 'receipt', 'expiry', 'epoch', 'abort']) {
    const f = fixture(), issuedAtMs = Date.now()
    const raw = T3ExecutionLegacyShellPreparationPayloadSchema.parse(JSON.parse(readFileSync(new URL(
      './t3-session-runtime/fixtures/execution-legacy-shell.json', import.meta.url), 'utf8')).preparation)
    const binding = f.admission.binding
    const slotId = hash(canonicalExecutorJson({ domain: T3_EXECUTION_LEGACY_SHELL_SLOT_DOMAIN,
      executorId: binding.executorId, sourceEvidenceDigest: binding.sourceEvidenceDigest,
      acceptedGraphNonce: '7'.repeat(64) })).slice(7)
    const observed = { ...raw, binding, slotId, nonce: slotId, acceptedGraphNonce: '7'.repeat(64),
      evidence: { ...raw.evidence, custody: f.custody }, issuedAtMs, expiresAtMs: issuedAtMs + 5000,
      observation: { ...raw.observation, observedAtMs: issuedAtMs } }
    const preparationReceipt = f.receipt(T3_EXECUTION_LEGACY_SHELL_PREPARATION_DOMAIN, observed)
    const candidate = { ...observed, issuerKeyId: preparationReceipt.keyId,
      preparationReceiptDigest: hash(preparationReceipt.payload), nonce: '0'.repeat(64), issuedAtMs: Date.now() }
    if (mode === 'targets') candidate.observation = { ...candidate.observation, targets: [] }
    if (mode === 'source') candidate.binding = { ...binding, sourceEvidenceDigest: hash('another-graph') }
    if (mode === 'receipt') candidate.preparationReceiptDigest = hash('another-receipt')
    if (mode === 'expiry') candidate.expiresAtMs++
    const answer = f.signed(candidate)
    let calls = 0
    const api = createExecutorApi({ fetchImpl: async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body)) as T3NativeExecutionOperationIntake
      assert.equal(body.operation, 'execution.legacyShells')
      if (body.operation !== 'execution.legacyShells') assert.fail('wrong operation')
      assert.equal(body.input.preparationReceipt.payload, preparationReceipt.payload)
      assert.equal(init?.redirect, 'error')
      if (mode === 'epoch') f.state = { ...f.state, connectionEpoch: '2' }
      if (mode === 'abort') f.controller.abort()
      return new Response(JSON.stringify({ data: answer }))
    } })
    const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
    const result = port.legacyShells({ preparationReceipt }, f.signal)
    if (mode === 'exact') assert.deepEqual(await result, answer)
    else await assert.rejects(result)
    assert.equal(calls, 1)
  }
})

test('whole shutdown HTTP preserves all observed targets and refuses altered evidence, expiry or epoch without retry', async () => {
  for (const mode of ['exact', 'targets', 'source', 'receipt', 'expiry', 'epoch', 'abort']) {
    const f = fixture(), issuedAtMs = Date.now()
    const raw = T3ExecutionShutdownPreparationPayloadSchema.parse(JSON.parse(readFileSync(new URL(
      './t3-session-runtime/fixtures/execution-shutdown.json', import.meta.url), 'utf8')).preparation)
    const binding = f.admission.binding
    const slotId = hash(canonicalExecutorJson({ domain: T3_EXECUTION_SHUTDOWN_SLOT_DOMAIN,
      executorId: binding.executorId, sourceEvidenceDigest: binding.sourceEvidenceDigest,
      acceptedGraphNonce: '7'.repeat(64) })).slice(7)
    const observed = { ...raw, binding, slotId, nonce: slotId, acceptedGraphNonce: '7'.repeat(64),
      evidence: { ...raw.evidence, custody: f.custody }, issuedAtMs, expiresAtMs: issuedAtMs + 5000,
      observation: { ...raw.observation, observedAtMs: issuedAtMs, selectionAtMs: issuedAtMs } }
    const preparationReceipt = f.receipt(T3_EXECUTION_SHUTDOWN_PREPARATION_DOMAIN, observed)
    const candidate = { ...observed, issuerKeyId: preparationReceipt.keyId,
      preparationReceiptDigest: hash(preparationReceipt.payload), nonce: '0'.repeat(64), issuedAtMs: Date.now() }
    if (mode === 'targets') candidate.observation = { ...candidate.observation, targets: [] }
    if (mode === 'source') candidate.binding = { ...binding, sourceEvidenceDigest: hash('another-graph') }
    if (mode === 'receipt') candidate.preparationReceiptDigest = hash('another-receipt')
    if (mode === 'expiry') candidate.expiresAtMs++
    const answer = f.signed(candidate)
    let calls = 0
    const api = createExecutorApi({ fetchImpl: async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body)) as T3NativeExecutionOperationIntake
      assert.equal(body.operation, 'execution.prepareShutdown')
      if (body.operation !== 'execution.prepareShutdown') assert.fail('wrong operation')
      assert.equal(body.input.preparationReceipt.payload, preparationReceipt.payload)
      assert.equal(init?.redirect, 'error')
      if (mode === 'epoch') f.state = { ...f.state, connectionEpoch: '2' }
      if (mode === 'abort') f.controller.abort()
      return new Response(JSON.stringify({ data: answer }))
    } })
    const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
    const result = port.prepareShutdown({ preparationReceipt }, f.signal)
    if (mode === 'exact') assert.deepEqual(await result, answer)
    else await assert.rejects(result)
    assert.equal(calls, 1)
  }
})

test('native client signs only the saved relay selector and preserves exact admission bytes', async () => {
  const f = fixture(), response = f.signed(f.admission)
  let calls = 0
  const api = createExecutorApi({ fetchImpl: async (url, init) => {
    calls++
    assert.equal(url, 'https://api.example.test/api/executor-daemon/t3/native-execution')
    assert.equal(init?.redirect, 'error')
    const { signature, ...payload } = JSON.parse(String(init?.body)) as T3NativeExecutionOperationIntake
    assert.equal(verify(null, Buffer.from(canonicalExecutorPayload(
      'nessie.executor.daemon.t3_native_execution.v1', payload)), f.key.publicKey,
    Buffer.from(signature, 'base64url')), true)
    assert.equal(payload.relayHmac, f.delivery.requestDigest)
    assert.equal(payload.correlationId, f.request.correlationId)
    assert.equal('actor' in payload || 'request' in payload || 'machinePrivateKey' in payload, false)
    return new Response(JSON.stringify({ data: response }))
  } })
  const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
  assert.deepEqual(await port.phase({ phase: 'reserve', graphId: f.graphId }, f.signal), response)
  assert.equal(calls, 1)
})

test('frame transport binds the exact receipt bytes, reservation and original operation', async () => {
  const f = fixture(), frameId = '9'.repeat(64)
  const prepared = { version: 1, reservationId: f.reservationId, frameId, binding: f.admission.binding,
    providerSessionId: 'original-provider-id', launchDigest: hash('actual-launch'), processPurpose: 'provider',
    child: f.generation,
    frame: { driver: 'codex', kind: 'request', protocolId: 1, frameSha256: hash('held-bytes') },
    nonce: frameId, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 4000,
    admissionDigest: hash('exact-launch-payload'), custody: f.custody }
  const receipt = f.receipt(T3_EXECUTION_FRAME_PREPARATION_DOMAIN, prepared)
  receipt.payload = JSON.stringify(prepared, null, 2)
  const { admissionDigest: _digest, custody: _custody, ...frame } = prepared
  const response = { ...frame, nonce: 'b'.repeat(64), issuerKeyId: '6'.repeat(64),
    releaseDigest: f.custody.releaseDigest, frameReceiptDigest: hash(receipt.payload) }
  let changed = false
  const api = createExecutorApi({ fetchImpl: async () => new Response(JSON.stringify({
    data: f.signed({ ...response,
      frameReceiptDigest: changed ? hash(JSON.stringify(prepared)) : response.frameReceiptDigest }),
  })) })
  const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
  assert.equal((await port.frame({ reservationId: f.reservationId, frameReceipt: receipt }, f.signal)).payload,
    f.signed(response).payload)
  changed = true
  await assert.rejects(port.frame({ reservationId: f.reservationId, frameReceipt: receipt }, f.signal), /FENCED/u)
})

test('late responses after paired identity replacement or parent abort cannot escape the bound port', async () => {
  for (const change of ['epoch', 'key', 'origin', 'abort']) {
    const f = fixture()
    const api = createExecutorApi({ fetchImpl: async () => {
      if (change === 'epoch') f.state.connectionEpoch = '2'
      else if (change === 'key') f.state.machinePublicKey = 'replacement-key'
      else if (change === 'origin') f.state.apiBaseUrl = 'https://other.example.test'
      else f.controller.abort()
      return new Response(JSON.stringify({ data: f.signed(f.admission) }))
    } })
    const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
    await assert.rejects(port.phase({ phase: 'reserve', graphId: f.graphId }, f.signal))
  }
})

test('cross-operation replies, raw frame selectors and unsigned origins are refused', async () => {
  const f = fixture()
  const api = createExecutorApi({ fetchImpl: async () => new Response(JSON.stringify({ data: f.signed({
    ...f.admission, binding: { ...f.admission.binding, correlationId: 'other' },
  }) })) })
  const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
  await assert.rejects(port.phase({ phase: 'reserve', graphId: f.graphId }, f.signal), /FENCED/u)
  assert.equal(T3NativeExecutionOperationSchema.safeParse({ operation: 'execution.frame',
    input: { reservationId: f.reservationId, method: 'write', frameSha256: hash('untrusted') } }).success, false)
  assert.equal(T3NativeExecutionOperationSchema.safeParse({ operation: 'execution.phase',
    input: { phase: 'reserve', graphId: f.graphId }, actor: 'caller' }).success, false)
  assert.equal(T3NativeExecutionOperationSchema.safeParse({ operation: 'execution.frame',
    input: { reservationId: f.reservationId, frameReceipt: { ...f.delivery.executionGraph,
      publicKey: 'caller-key' } } }).success, false)
  f.state.apiBaseUrl = 'http://api.example.test'
  assert.throws(() => createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api), /FENCED/u)
})

test('oversized native responses are cancelled without retry or synthetic success', async () => {
  const f = fixture()
  let calls = 0, cancelled = false
  const api = createExecutorApi({ fetchImpl: async () => {
    calls++
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)) },
      cancel() { cancelled = true } }))
  } })
  const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
  await assert.rejects(port.phase({ phase: 'reserve', graphId: f.graphId }, f.signal), /exceeds its bound/u)
  assert.equal(calls, 1)
  assert.equal(cancelled, true)
})

test('receipt acknowledgement expiry and reservation substitution refuse without replay', async () => {
  const f = fixture()
  let expiresAt = new Date(Date.now() - 1).toISOString(), reservationId = f.reservationId, calls = 0
  const api = createExecutorApi({ fetchImpl: async () => {
    calls++
    return new Response(JSON.stringify({ data: { reservationId, expiresAt, domain: T3_EXECUTION_RESERVATION_DOMAIN } }))
  } })
  const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
  const receipt = f.receipt(T3_EXECUTION_RESERVATION_DOMAIN, { reservationId: f.reservationId })
  await assert.rejects(port.receipt(receipt, f.signal), /FENCED/u)
  expiresAt = new Date(Date.now() + 5000).toISOString()
  reservationId = 'f'.repeat(64)
  await assert.rejects(port.receipt(receipt, f.signal), /FENCED/u)
  f.controller.abort()
  await assert.rejects(port.receipt(receipt, f.signal))
  assert.equal(calls, 2)
})

test('injected response keys and expired phase envelopes cannot become transport success', async () => {
  for (const kind of ['key', 'expiry']) {
    const f = fixture()
    const response = kind === 'key' ? { ...f.signed(f.admission), publicKey: 'caller-key' }
      : f.signed({ ...f.admission, issuedAtMs: Date.now() - 5000, expiresAtMs: Date.now() - 1 })
    const api = createExecutorApi({ fetchImpl: async () => new Response(JSON.stringify({ data: response })) })
    const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
    await assert.rejects(port.phase({ phase: 'reserve', graphId: f.graphId }, f.signal))
  }
})

test('secret read request preserves the original relay, receipt and remaining total deadline', async () => {
  const f = secretReadFixture()
  let calls = 0
  const api = { nativeExecution: async (_url: string, input: T3NativeExecutionOperationIntake,
    options?: { signal?: AbortSignal; timeoutMs?: number }) => {
    calls++
    const { signature, ...payload } = input
    assert.equal(input.operation, 'execution.secretRead')
    assert.equal(input.relayHmac, f.delivery.requestDigest)
    assert.equal(input.correlationId, f.request.correlationId)
    assert.equal(verify(null, Buffer.from(canonicalExecutorPayload(
      'nessie.executor.daemon.t3_native_execution.v1', payload)), f.key.publicKey,
    Buffer.from(signature, 'base64url')), true)
    assert.ok(options?.timeoutMs && options.timeoutMs <= 4000 && options.timeoutMs > 0)
    assert.deepEqual('input' in input && input.input, { preparationReceipt: f.preparationReceipt })
    // Refusal, not a fabricated positive enrolled/native response.
    throw new Error('T3_EXECUTION_AUTHORITY_UNAVAILABLE')
  } }
  const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
  await assert.rejects(port.secretRead({ preparationReceipt: f.preparationReceipt }, f.signal), /UNAVAILABLE/u)
  assert.equal(calls, 1)
})

test('expired or mismatched secret observations refuse before any HTTP request', async () => {
  for (const change of [{ issuedAtMs: Date.now() - 6000, expiresAtMs: Date.now() - 1000 },
    { acceptedGraphNonce: '0'.repeat(64) }]) {
    const f = secretReadFixture()
    let calls = 0
    const api = createExecutorApi({ fetchImpl: async () => { calls++; throw new Error('HTTP reached') } })
    const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
    const receipt = { ...f.preparationReceipt, payload: JSON.stringify({ ...f.observed, ...change }) }
    await assert.rejects(port.secretRead({ preparationReceipt: receipt }, f.signal))
    assert.equal(calls, 0)
  }
})

test('secret response cannot reset the observation window or substitute any held destination', async () => {
  for (const change of ['renew', 'recipient', 'digest', 'key', 'expired']) {
    const f = secretReadFixture()
    const candidate = { ...f.candidate }
    if (change === 'renew') candidate.expiresAtMs = candidate.issuedAtMs + 5000
    if (change === 'recipient') candidate.recipient = { ...candidate.recipient, slotId: '3'.repeat(64) }
    if (change === 'digest') candidate.preparationReceiptDigest = hash(JSON.stringify(f.observed))
    if (change === 'key') candidate.issuerKeyId = '3'.repeat(64)
    if (change === 'expired') { candidate.issuedAtMs -= 6000; candidate.expiresAtMs = Date.now() - 1 }
    let calls = 0
    const api = createExecutorApi({ fetchImpl: async () => {
      calls++
      return new Response(JSON.stringify({ data: f.signed(candidate) }))
    } })
    const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
    await assert.rejects(port.secretRead({ preparationReceipt: f.preparationReceipt }, f.signal))
    assert.equal(calls, 1)
  }
})

test('effect proof requires accepted association and derives every selector from the captured launch', async t => {
  const f = fixture(), issuer = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const association = { version: 1, binding: f.admission.binding, reservationId: f.reservationId,
    providerSessionId: 'actual-original-session', launchDigest: hash('launch'), admissionDigest: hash('admission'),
    processPurpose: 'provider', custody: f.custody, nativeId: 'observed-native', provider: f.generation,
    providerImageDigest: 'a'.repeat(64), observation: { kind: 'service-held-provider-stdout',
      requestId: '1', frameDigest: hash('stdout'), observedAtMs: Date.now() },
    nonce: 'b'.repeat(64), issuedAtMs: Date.now(), expiresAtMs: Date.now() + 5000 }
  const receipt = f.receipt(T3_EXECUTION_ASSOCIATION_DOMAIN, association)
  let expiresAt = new Date(Date.now() + 60_000).toISOString(), calls = 0, replaced = false
  const api = createExecutorApi({ fetchImpl: async () => new Response(JSON.stringify({ data: {
    reservationId: f.reservationId, domain: receipt.domain, expiresAt,
  } })) })
  t.mock.method(executorApi, 't3EffectIssuerKeys', async () => ({ keys: [
    { ...issuer.publicKey.export({ format: 'jwk' }), kid: 'issuer', alg: 'RS256', use: 'sig' },
  ] }))
  t.mock.method(executorApi, 'checkT3EffectAuthority', async (_url, input) => {
    calls++
    assert.deepEqual(input.selection, { kind: 't3-effect', version: 1, purpose: 'execute',
      executorId: f.request.executorId, environmentId: f.request.environmentId, threadId: 'thread:one',
      providerSessionId: association.providerSessionId, connectionEpoch: f.request.connectionEpoch,
      runtimeGeneration: f.request.runtimeGeneration, correlationId: f.request.correlationId,
      commandId: 'command:one', requestDigest: f.delivery.requestDigest, nativeAssociation: {
        driver: 'codex', nativeId: association.nativeId, continuationHomeKey: 'continuation:one',
        historyHomeKey: 'history:one' } })
    const { signature: _signature, ...payload } = input
    const grant = { ...input.selection, issuedAt: input.observedAt,
      expiresAt: new Date(Date.now() + 4000).toISOString(), requestNonce: input.requestNonce,
      requestProofDigest: hash(canonicalExecutorJson(payload)) }
    if (replaced) f.state = { ...f.state, connectionEpoch: '2' }
    return { grant, keyId: 'issuer', signature: sign('RSA-SHA256',
      Buffer.from(canonicalExecutorPayload(T3_EFFECT_SIGNATURE_DOMAIN, grant)), issuer.privateKey).toString('base64url') }
  })
  const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
  await assert.rejects(port.effect(f.signal), /FENCED/u)
  assert.equal(calls, 0)
  await port.receipt(receipt, f.signal)
  const proof = await port.effect(f.signal)
  assert.equal(verify('RSA-SHA256', Buffer.from(canonicalExecutorPayload(T3_EFFECT_SIGNATURE_DOMAIN, proof.grant)),
    issuer.publicKey, Buffer.from(proof.signature, 'base64url')), true)
  assert.equal(T3NativeExecutionOperationSchema.safeParse({ operation: 'execution.effect' }).success, true)
  assert.equal(T3NativeExecutionOperationSchema.safeParse({ operation: 'execution.effect',
    selection: proof.grant }).success, false)
  assert.equal(T3NativeExecutionIntakeSchema.safeParse({ operation: 'execution.effect' }).success, false)
  await assert.rejects(port.receipt({ ...receipt, payload: JSON.stringify({ ...association,
    nativeId: 'substituted-native' }) }, f.signal), /FENCED/u)
  // The backend retention cap may shorten, but replay must never lengthen it.
  expiresAt = new Date(Date.now() + 2000).toISOString()
  await port.receipt(receipt, f.signal)
  expiresAt = new Date(Date.now() + 60_000).toISOString()
  await port.receipt(receipt, f.signal)
  await assert.rejects(port.effect(f.signal), /FENCED/u)
  replaced = true
  await assert.rejects(port.effect(f.signal), /REFUSED/u)
  f.controller.abort()
  await assert.rejects(port.effect(f.signal))
  assert.equal(calls, 3)
})
