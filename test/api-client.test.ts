import assert from 'node:assert/strict'
import test from 'node:test'

import { createExecutorApi, ExecutorApiError } from '../src/api-client.js'

const hangingFetch: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
  const signal = init?.signal
  if (!signal) {
    reject(new Error('missing abort signal'))
    return
  }
  const abort = () => reject(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
})

test('client-recovery: every executor API request has a bounded deadline', async () => {
  const client = createExecutorApi({ fetchImpl: hangingFetch, requestTimeoutMs: 10 })
  await assert.rejects(
    client.issueChallenge('https://api.example.test', 'executor'),
    (error: unknown) => (
      error instanceof ExecutorApiError
      && error.code === 'EXECUTOR_API_TIMEOUT'
      && error.message === 'Executor API request timed out.'
    ),
  )
})

test('client-recovery: daemon shutdown cancels pending executor API requests', async () => {
  const client = createExecutorApi({ fetchImpl: hangingFetch, requestTimeoutMs: 10_000 })
  const request = client.issueChallenge('https://api.example.test', 'executor')
  client.cancelPending()
  await assert.rejects(
    request,
    (error: unknown) => (
      error instanceof ExecutorApiError
      && error.code === 'EXECUTOR_API_CANCELLED'
      && error.message === 'Executor API request was cancelled.'
    ),
  )
})

test('client-recovery: executor API errors retain their stable server code', async () => {
  const client = createExecutorApi({
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: 'EXECUTOR_COMMAND_REPLAY', message: 'Receipt is out of order.' },
    }), { status: 409 }),
  })
  await assert.rejects(
    client.issueChallenge('https://api.example.test', 'executor'),
    (error: unknown) => (
      error instanceof ExecutorApiError
      && error.code === 'EXECUTOR_COMMAND_REPLAY'
      && error.status === 409
    ),
  )
})

test('an attachment upload is posted to its route under its own, size-scaled deadline', async () => {
  const posted: Array<{ body: unknown; url: string }> = []
  const recording = createExecutorApi({
    fetchImpl: async (input, init) => {
      posted.push({ body: JSON.parse(String(init?.body)), url: String(input) })
      return new Response(JSON.stringify({ data: { recorded: true } }), { status: 200 })
    },
    requestTimeoutMs: 10,
  })
  const input = {
    attachment: {
      byteLength: 3,
      commandId: '00000000-0000-4000-8000-000000000503',
      digest: `sha256:${'a'.repeat(64)}`,
      mimeType: 'image/png',
      occurredAt: '2026-09-23T10:00:00.000Z',
    },
    connectionEpoch: '1',
    dataBase64: 'AAAA',
    executorId: 'executor',
    signature: 'signature',
  } as Parameters<typeof recording.uploadCommandAttachment>[1]
  assert.deepEqual(
    await recording.uploadCommandAttachment('https://api.example.test/', input, { timeoutMs: 5_000 }),
    { recorded: true },
  )
  assert.deepEqual(posted, [{ body: input, url: 'https://api.example.test/api/executor-daemon/commands/attachment' }])

  // The upload's deadline is its own, not the client's default for small requests.
  const hanging = createExecutorApi({ fetchImpl: hangingFetch, requestTimeoutMs: 10_000 })
  const started = Date.now()
  await assert.rejects(
    hanging.uploadCommandAttachment('https://api.example.test', input, { timeoutMs: 20 }),
    (error: unknown) => error instanceof ExecutorApiError && error.code === 'EXECUTOR_API_TIMEOUT',
  )
  assert.ok(Date.now() - started < 5_000)
})
