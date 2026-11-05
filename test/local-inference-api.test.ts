import assert from 'node:assert/strict'
import test from 'node:test'

import { createLocalInferenceDaemonApi, LocalInferenceApiError } from '../src/local-inference-api.js'
import { localInferenceFailure } from '../src/local-inference-failure.js'
import { HOST_ID } from './fixtures/local-inference-host.js'

test('an interrupted response body is ambiguous transport, not malformed JSON', async () => {
  const api = createLocalInferenceDaemonApi({ apiBaseUrl: 'https://nessie.test', fetchImpl: async () => {
    return new Response(new ReadableStream({ start(controller) {
      controller.error(new TypeError('private-url?token=secret', { cause: { code: 'UND_ERR_BODY_TIMEOUT' } }))
    } }))
  } })
  await assert.rejects(api.issueChallenge({ hostId: HOST_ID }), (error: unknown) => (
    error instanceof LocalInferenceApiError
    && error.code === 'LOCAL_INFERENCE_API_UNREACHABLE' && error.transportCode === 'UND_ERR_BODY_TIMEOUT'))
})

test('malformed JSON and a response without data fail closed', async () => {
  for (const body of ['not-json', JSON.stringify({ result: {} })]) {
    const api = createLocalInferenceDaemonApi({ apiBaseUrl: 'https://nessie.test', fetchImpl: async () => new Response(body) })
    await assert.rejects(api.issueChallenge({ hostId: HOST_ID }), (error: unknown) => (
      error instanceof LocalInferenceApiError
      && error.code === 'LOCAL_INFERENCE_API_INVALID'))
  }
})

test('the request timeout also bounds reading its response body', async () => {
  const api = createLocalInferenceDaemonApi({ apiBaseUrl: 'https://nessie.test', requestTimeoutMs: 10,
    fetchImpl: async (_url, input) => new Response(new ReadableStream({ start(controller) {
      input.signal?.addEventListener('abort', () => { controller.error(new DOMException('Aborted', 'AbortError')) })
    } })),
  })
  await assert.rejects(api.issueChallenge({ hostId: HOST_ID }), (error: unknown) => (
    error instanceof LocalInferenceApiError
    && error.code === 'LOCAL_INFERENCE_API_TIMEOUT'))
})

test('safe failure summaries omit unrecognized codes and all exception messages', () => {
  const failure = localInferenceFailure(new LocalInferenceApiError('token=secret', 503, 'private-url'))
  assert.deepEqual(failure, { category: 'relay', code: 'local_inference_delivery_failed', status: 503 })
  assert.deepEqual(localInferenceFailure(new Error('prompt and keys')), { category: 'host', code: 'local_inference_host_failed' })
})


test('receipt-only HTTPS methods retain original signed payloads and expose only fixed receipt paths', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const api = createLocalInferenceDaemonApi({ apiBaseUrl: 'https://nessie.test', fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ data: { acknowledged: true } }))
  } })
  const original = { envelope: { connectionEpoch: '3', executorConnectionEpoch: '1' }, receipt: { attemptId: HOST_ID } }
  await api.resultReceipt(original as Parameters<typeof api.resultReceipt>[0])
  assert.equal(calls[0]?.url, 'https://nessie.test/api/local-inference/daemon/receipts/result')
  assert.deepEqual(calls[0]?.body, original)
})


test('original receipt status is fixed-path and exposes only validated stored digest', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const digest = 'a'.repeat(64)
  const api = createLocalInferenceDaemonApi({ apiBaseUrl: 'https://nessie.test', fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    return Response.json({ data: { acknowledged: true, resultDigest: digest } })
  } })
  const original = { envelope: { connectionEpoch: '3', executorConnectionEpoch: '1' }, receipt: { attemptId: HOST_ID } }
  assert.deepEqual(await api.receiptStatus(original as Parameters<typeof api.receiptStatus>[0]),
    { acknowledged: true, resultDigest: digest })
  assert.equal(calls[0]?.url, 'https://nessie.test/api/local-inference/daemon/receipts/status')
  assert.deepEqual(calls[0]?.body, original)
  const malformed = createLocalInferenceDaemonApi({ apiBaseUrl: 'https://nessie.test',
    fetchImpl: async () => Response.json({ data: { acknowledged: true, resultDigest: digest, content: 'forbidden' } }) })
  await assert.rejects(malformed.receiptStatus(original as Parameters<typeof malformed.receiptStatus>[0]))
})
