import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import test from 'node:test'
import { canonicalExecutorPayload } from '@nessie/executor-protocol'
import { decodeExecutorT3LaneOperation, encodeExecutorT3LaneOperation, T3_SOURCE_COMMIT,
  T3_EXECUTION_GRAPH_DOMAIN, T3_EXECUTION_FRAME_PREPARATION_DOMAIN, T3_EXECUTION_RESERVATION_DOMAIN,
  T3NativeExecutionOperationSchema,
  type T3ExecutionReceipt, type T3NativeExecutionOperationIntake,
} from '@nessie/executor-protocol/t3-session'
import { createExecutorApi } from '../src/api-client.js'
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
    continuationHomeKey: 'continuation:one', historyHomeKey: 'history:one', credentialBindingId: 'credential:one' }
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
  const admission = { version: 1, phase: 'reserve', binding: { ...binding, sourceEvidenceDigest: hash('graph') },
    reservationId, issuerKeyId: '6'.repeat(64), releaseDigest: custody.releaseDigest, nonce: '8'.repeat(64),
    issuedAtMs: now, expiresAtMs: now + 5000 }
  const signed = (payload: unknown) => ({ payload: JSON.stringify(payload, null, 2),
    keyId: 'backend', signature: 'abc' })
  const controller = new AbortController()
  return { request, delivery, state, admission, signed, key, graphId, reservationId, controller, receipt, custody,
    signal: controller.signal, generation }
}

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
    data: f.signed({ ...response, frameReceiptDigest: changed ? hash(JSON.stringify(prepared)) : response.frameReceiptDigest }),
  })) })
  const port = createT3NativeExecutionTransport(() => f.state, f.request, f.delivery, f.signal, api)
  assert.equal((await port.frame({ reservationId: f.reservationId, frameReceipt: receipt }, f.signal)).payload,
    f.signed(response).payload)
  changed = true
  await assert.rejects(port.frame({ reservationId: f.reservationId, frameReceipt: receipt }, f.signal), /FENCED/u)
})

test('late responses after epoch replacement or parent abort cannot escape the bound port', async () => {
  for (const change of ['epoch', 'abort']) {
    const f = fixture()
    const api = createExecutorApi({ fetchImpl: async () => {
      if (change === 'epoch') f.state.connectionEpoch = '2'
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
