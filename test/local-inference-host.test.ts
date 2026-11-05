import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import type { LocalInferenceAttemptRequest } from '@nessie/executor-protocol'
import { LocalInferenceAttemptFrameSchema } from '@nessie/executor-protocol'

import { LocalInferenceApiError } from '../src/local-inference-api.js'
import { LocalInferenceHostLoop } from '../src/local-inference-host.js'
import { OllamaChatError, streamOllamaChat } from '../src/ollama-chat.js'
import type { OllamaFetch } from '../src/ollama-client.js'
import {
  HOST_ID, ORG_ID, ATTEMPT_ID, RESOURCE_ID, ADMISSION, coordinatorFixture,
  machineKeys, attempt, ollama, localResult, receiptJournal, apiFor,
} from './fixtures/local-inference-host.js'

test('the host relays a fixed typed Ollama request and signs independent daemon lanes', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api, calls } = apiFor(attempt())
  const loop = new LocalInferenceHostLoop({
    transport: api,
    coordinator: await coordinatorFixture(t),
    fetchImpl: ollama([
      { done: false, message: { content: 'hello' }, model: 'local:latest' },
      { done: true, done_reason: 'stop', eval_count: 2, message: { content: '' }, model: 'local:latest', prompt_eval_count: 3 },
    ]),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false,
    journal,
    origin: 'http://127.0.0.1:11434',
  })

  await loop.heartbeat()
  const outcome = await loop.pollOnce()

  assert.deepEqual(outcome, { attemptId: ATTEMPT_ID, kind: 'completed' })
  assert.equal(calls.heartbeats.length, 1)
  assert.equal(calls.frames.length, 1)
  assert.equal(Buffer.from(calls.frames[0]?.frame.data ?? '', 'base64url').toString('utf8'),
    JSON.stringify({ type: 'output_text.delta', text: 'hello' }))
  assert.equal(calls.results[0]?.receipt.result.content, 'hello')
  assert.equal(calls.results[0]?.receipt.result.usage.outputTokens, 2)
  assert.equal(typeof calls.results[0]?.receipt.result.generationMs, 'number')
  assert.equal(calls.frames[0]?.frame.final, true, 'The stream ends on a final frame.')
  assert.equal(calls.accepts.length, 1, 'The host accepts once and never asks for control again.')
  assert.equal(calls.heartbeats[0]?.heartbeat.paused, false)
})

test('a model without a reported context size still produces a signed receipt', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api, calls } = apiFor(attempt())
  const loop = new LocalInferenceHostLoop({
    transport: api,
    coordinator: await coordinatorFixture(t),
    fetchImpl: ollama([
      { done: false, message: { content: 'hello' }, model: 'local:latest' },
      { done: true, done_reason: 'stop', message: { content: '' }, model: 'local:latest' },
    ], null),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false,
    journal,
    origin: 'http://127.0.0.1:11434',
  })

  assert.deepEqual(await loop.pollOnce(), { attemptId: ATTEMPT_ID, kind: 'completed' })
  assert.equal(calls.results[0]?.receipt.result.content, 'hello')
})

test('a remote marker in any streamed chat object aborts acceptance', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api, calls } = apiFor(attempt())
  const loop = new LocalInferenceHostLoop({
    transport: api,
    coordinator: await coordinatorFixture(t),
    fetchImpl: ollama([{ done: true, message: {}, model: 'local:latest', remote_model: 'cloud:latest' }]),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false,
    journal,
    origin: 'http://127.0.0.1:11434',
  })

  await loop.pollOnce()

  assert.equal(calls.results[0]?.receipt.result.content, null)
  assert.equal(calls.results[0]?.receipt.result.finishReason, 'error')
  const error = Buffer.from(calls.frames[0]?.frame.data ?? '', 'base64url').toString('utf8')
  assert.match(error, /protocol_error/)
})

test('a durable encrypted receipt is retried without dialing Ollama again', async (t) => {
  const keys = machineKeys()
  const { getStored, journal } = receiptJournal()
  await journal.record({ attemptId: ATTEMPT_ID, dispatchFence: 1, result: localResult() })
  assert.ok(getStored())
  assert.doesNotMatch(getStored()?.ciphertext ?? '', /saved result/)
  const { api, calls } = apiFor(attempt())
  let ollamaCalls = 0
  const loop = new LocalInferenceHostLoop({
    transport: api,
    coordinator: await coordinatorFixture(t),
    fetchImpl: ((url, init) => {
      ollamaCalls += 1
      return ollama([])(url, init)
    }),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false,
    journal,
    origin: 'http://127.0.0.1:11434',
  })

  await loop.pollOnce()

  assert.equal(ollamaCalls, 0)
  assert.equal(calls.results[0]?.receipt.result.content, 'saved result')
  assert.equal(await journal.get({ attemptId: ATTEMPT_ID, dispatchFence: 1 }), undefined)
})

test('a lost poll response keeps its exact request token and cannot admit a second transport', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api } = apiFor(attempt())
  const coordinator = await coordinatorFixture(t)
  const ids: string[] = []
  const original = api.claim
  api.claim = async (input) => {
    ids.push(input.requestId)
    if (ids.length === 1) throw new Error('response interrupted after server commit')
    return original(input)
  }
  const loop = new LocalInferenceHostLoop({
    transport: api, coordinator, fetchImpl: ollama([{ done: true, message: { content: 'done' } }]),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false, journal, origin: 'http://127.0.0.1:11434',
  })
  await assert.rejects(loop.pollOnce(), /response interrupted/)
  assert.equal(await coordinator.acquire('different-host'), null)
  await loop.pollOnce()
  assert.equal(ids.length, 2)
  assert.equal(ids[0], ids[1])
  assert.ok(await coordinator.acquire('different-host'), 'The waiting transport gets the freed physical slot.')
})

test('one host can fill two configured slots while a third call waits', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api } = apiFor(attempt())
  const coordinator = await coordinatorFixture(t)
  await coordinator.syncControl({
    resourceId: RESOURCE_ID, capacity: 2, controlRevision: 1, paused: false, healthReason: null,
  })
  api.claim = async () => ({
    admission: { ...ADMISSION, admissionId: randomUUID(), fence: randomUUID() },
    attempt: { ...attempt(), attemptId: randomUUID() }, dispatchFence: 1,
  })
  const finishes: Array<() => void> = []
  const fetchImpl: OllamaFetch = (url, init) => url.endsWith('/api/chat')
    ? Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        finishes.push(() => {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ done: true, message: { content: 'ok' } })}\n`))
          controller.close()
        })
      },
    })))
    : ollama([])(url, init)
  const loop = new LocalInferenceHostLoop({
    transport: api, coordinator, fetchImpl,
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false, journal, origin: 'http://127.0.0.1:11434',
  })
  const first = loop.pollOnce()
  const until = async (count: number) => {
    const deadline = Date.now() + 2_000
    while (finishes.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(finishes.length, count)
  }
  await until(1)
  const second = loop.pollOnce()
  await until(2)
  assert.deepEqual(await loop.pollOnce(), { kind: 'busy' })
  for (const finish of finishes) finish()
  assert.equal((await first).kind, 'completed')
  assert.equal((await second).kind, 'completed')
})

const blockedChat = (onAbort: () => void, started: () => void): OllamaFetch => ((url, init) => {
  if (url.endsWith('/api/chat')) {
    started()
    const signal = init?.signal as AbortSignal
    return Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => { onAbort(); controller.error(new Error('aborted')) }, { once: true })
      },
    })))
  }
  return ollama([])(url, init)
}) as OllamaFetch

test('a pushed cancel aborts a blocked Ollama stream at once, with no control request', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api, calls } = apiFor(attempt())
  let aborted = false
  let started!: () => void
  const invoked = new Promise<void>((resolve) => { started = resolve })
  const loop = new LocalInferenceHostLoop({
    transport: api,
    coordinator: await coordinatorFixture(t),
    fetchImpl: blockedChat(() => { aborted = true }, () => started()),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false,
    journal,
    origin: 'http://127.0.0.1:11434',
  })
  const outcome = loop.pollOnce()
  await invoked
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(aborted, false)
  assert.equal(calls.accepts.length, 1, 'One acceptance, and no further control request while blocked.')
  const pushedAt = Date.now()
  loop.applyControl(ATTEMPT_ID, 'cancelled')
  await outcome
  assert.equal(aborted, true)
  assert.ok(Date.now() - pushedAt < 1_000)
  assert.equal(calls.accepts.length, 1)
  assert.match(Buffer.from(calls.frames.at(-1)?.frame.data ?? '', 'base64url').toString('utf8'), /response.error/)
  assert.equal(calls.frames.at(-1)?.frame.final, true)
})

test('an acceptance answered cancelled aborts the stream it raced', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api } = apiFor(attempt())
  let aborted = false
  api.accept = async () => ({ state: 'cancelled' })
  const loop = new LocalInferenceHostLoop({
    transport: api,
    coordinator: await coordinatorFixture(t),
    fetchImpl: blockedChat(() => { aborted = true }, () => undefined),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false,
    journal,
    origin: 'http://127.0.0.1:11434',
  })
  await loop.pollOnce()
  assert.equal(aborted, true)
})

test('the chat transport refuses a remote result before yielding an event', async () => {
  const controller = new AbortController()
  await assert.rejects(async () => {
    for await (const event of streamOllamaChat({
      attempt: attempt(),
      fetchImpl: ollama([{ done: true, message: {}, model: 'local:latest', remote_host: 'cloud.example' }]),
      origin: 'http://127.0.0.1:11434',
      signal: controller.signal,
      think: false,
    })) {
      void event
      throw new Error('must not yield')
    }
  }, OllamaChatError)
})

test('the chat transport sends Ollama the thinking switch it was given and relays the thinking', async () => {
  let request: Record<string, unknown> | undefined
  const fetchImpl: OllamaFetch = async (url, init) => {
    if (url.endsWith('/api/chat')) request = JSON.parse(String(init.body)) as Record<string, unknown>
    return ollama([
      { done: false, message: { content: '', thinking: 'Weighing ' }, model: 'local:latest' },
      { done: false, message: { content: '', thinking: 'the answer.' }, model: 'local:latest' },
      { done: true, message: { content: 'answer' }, model: 'local:latest' },
    ])(url, init)
  }
  const thinking: string[] = []
  const text: string[] = []
  for await (const event of streamOllamaChat({
    attempt: { ...attempt(), thinking: true }, fetchImpl, origin: 'http://127.0.0.1:11434',
    signal: new AbortController().signal, think: true,
  })) {
    if (event.thinking !== undefined) thinking.push(event.thinking)
    if (event.text !== undefined) text.push(event.text)
  }
  assert.equal(request?.think, true)
  assert.deepEqual(thinking, ['Weighing ', 'the answer.'])
  assert.deepEqual(text, ['answer'])

  for await (const event of streamOllamaChat({
    attempt: attempt(), fetchImpl, origin: 'http://127.0.0.1:11434', signal: new AbortController().signal, think: false,
  })) void event
  assert.equal(request?.think, false)
})

test('a prior turn\'s reasoning goes back to Ollama as the assistant message\'s thinking', async () => {
  let request: Record<string, unknown> | undefined
  const fetchImpl: OllamaFetch = async (url, init) => {
    if (url.endsWith('/api/chat')) request = JSON.parse(String(init.body)) as Record<string, unknown>
    return ollama([{ done: true, message: { content: 'answer' }, model: 'local:latest' }])(url, init)
  }
  for await (const event of streamOllamaChat({
    attempt: {
      ...attempt(),
      messages: [
        { content: 'Say hello', role: 'user' },
        { content: null, reasoning: 'I should greet.', role: 'assistant', toolCalls: [{ arguments: {}, toolCallId: 'c1', toolName: 'safe_tool' }] },
        { content: 'ok', role: 'tool', toolCallId: 'c1' },
      ],
    }, fetchImpl, origin: 'http://127.0.0.1:11434', signal: new AbortController().signal, think: false,
  })) void event
  const messages = request?.messages as Array<Record<string, unknown>>
  assert.equal(messages[1]?.thinking, 'I should greet.')
})

test('an unbounded main attempt omits Ollama num_predict', async () => {
  let request: Record<string, unknown> | undefined
  const fetchImpl: OllamaFetch = async (url, init) => {
    if (url.endsWith('/api/chat')) request = JSON.parse(String(init.body)) as Record<string, unknown>
    return ollama([{ done: true, message: { content: 'answer' }, model: 'local:latest' }])(url, init)
  }
  const unbounded = attempt()
  delete unbounded.maxOutputTokens
  for await (const event of streamOllamaChat({
    attempt: unbounded, fetchImpl, origin: 'http://127.0.0.1:11434', signal: new AbortController().signal,
    think: false,
  })) void event
  assert.equal((request?.options as Record<string, unknown> | undefined)?.num_predict, undefined)
})

test('model-default context preserves Ollama configuration while explicit contexts retain their value', async () => {
  const requests: Array<Record<string, unknown>> = []
  const fetchImpl: OllamaFetch = async (url, init) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return ollama([{ done: true, message: { content: 'answer' }, model: 'local:latest' }])(url, init)
  }
  for (const useModelDefaultContext of [true, undefined] as const) {
    for await (const event of streamOllamaChat({
      attempt: { ...attempt(), numCtx: 4096 }, fetchImpl, origin: 'http://127.0.0.1:11434',
      signal: new AbortController().signal, think: false,
      ...(useModelDefaultContext ? { useModelDefaultContext, preventContextLoss: true as const } : {}),
    })) void event
  }
  assert.equal((requests[0]?.options as Record<string, unknown>).num_ctx, undefined)
  assert.equal(requests[0]?.truncate, false)
  assert.equal(requests[0]?.shift, false)
  assert.equal((requests[1]?.options as Record<string, unknown>).num_ctx, 4096)
  assert.equal(requests[1]?.truncate, undefined)
})

test('tool ids are scoped to the durable invocation, not an Ollama-local counter', async () => {
  const toolAttempt = (): LocalInferenceAttemptRequest => ({
    ...attempt(),
    tools: [{ description: 'A safe tool', inputSchema: { type: 'object' }, toolName: 'safe_tool' }],
  })
  const response = [{
    done: true,
    message: { tool_calls: [{ function: { arguments: {}, name: 'safe_tool' } }] },
    model: 'local:latest',
  }]
  const first = toolAttempt()
  const second = { ...toolAttempt(), invocationId: 'invocation-2' }
  const calls = await Promise.all([first, second].map(async (request) => {
    for await (const event of streamOllamaChat({
      attempt: request, fetchImpl: ollama(response), origin: 'http://127.0.0.1:11434', signal: new AbortController().signal,
      think: false,
    })) return event.toolCalls?.[0]?.toolCallId
    return undefined
  }))
  assert.deepEqual(calls, ['invocation-1:ollama-1', 'invocation-2:ollama-1'])
})

test('frame transport rejects malformed base64url before it reaches storage', () => {
  assert.equal(LocalInferenceAttemptFrameSchema.safeParse({
    attemptId: ATTEMPT_ID, data: '%', dispatchFence: 1, final: false, sequence: 1,
  }).success, false)
})

test('a poll the server refuses outright releases its reservation; a lost answer keeps the token', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api } = apiFor(attempt())
  const coordinator = await coordinatorFixture(t)
  const ids: string[] = []
  let answer: 'refuse' | 'lose' | 'idle' = 'refuse'
  api.claim = async (input) => {
    ids.push(input.requestId)
    if (answer === 'refuse') throw new LocalInferenceApiError('LOCAL_HOST_FENCED', 409)
    if (answer === 'lose') throw new LocalInferenceApiError('LOCAL_INFERENCE_API_TIMEOUT')
    return { attempt: null, dispatchFence: null, admission: null }
  }
  const loop = new LocalInferenceHostLoop({
    transport: api, coordinator, fetchImpl: ollama([]),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false, journal, origin: 'http://127.0.0.1:11434',
  })
  await assert.rejects(loop.pollOnce(), /LOCAL_HOST_FENCED/)
  const other = await coordinator.acquire('different-host')
  assert.ok(other, 'A refused poll admitted nothing on the server, so the slot is free for the host that can use it.')
  await other.releaseIdle()
  answer = 'lose'
  await assert.rejects(loop.pollOnce(), /LOCAL_INFERENCE_API_TIMEOUT/)
  assert.equal(await coordinator.acquire('different-host'), null, 'A lost answer may hide an admission; keep the token.')
  answer = 'idle'
  await loop.pollOnce()
  assert.equal(ids.length, 3)
  assert.notEqual(ids[0], ids[1], 'The refused token was not replayed.')
  assert.equal(ids[1], ids[2], 'The lost token was replayed.')
  assert.ok(await coordinator.acquire('different-host'))
})

test('an answer for a token whose slot was reclaimed is terminated honestly, never run without a slot', async (t) => {
  const keys = machineKeys()
  const { journal } = receiptJournal()
  const { api, calls } = apiFor(attempt())
  const coordinator = await coordinatorFixture(t)
  const terminations: unknown[] = []
  api.terminate = async (termination) => { terminations.push(termination); return { acknowledged: true } }
  let generations = 0
  const original = api.claim
  api.claim = async (input) => {
    // Another transport reclaims the slot while this answer is in flight.
    await (await import('node:fs/promises')).unlink(`${(coordinator as unknown as { directory: string }).directory}/slot-0.json`)
    return original(input)
  }
  const loop = new LocalInferenceHostLoop({
    transport: api, coordinator,
    fetchImpl: ((url, init) => {
      if (url.endsWith('/api/chat')) generations += 1
      return ollama([{ done: true, message: { content: 'never' } }])(url, init)
    }) as OllamaFetch,
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false, journal, origin: 'http://127.0.0.1:11434',
  })
  assert.deepEqual(await loop.pollOnce(), { attemptId: ATTEMPT_ID, kind: 'fenced' })
  assert.equal(generations, 0)
  assert.equal(calls.results.length, 0)
  assert.deepEqual(terminations, [{ ...ADMISSION, attemptId: ATTEMPT_ID, confirmed: true }])
  // The next poll starts from a fresh token.
  assert.ok(await coordinator.acquire('different-host'))
})
