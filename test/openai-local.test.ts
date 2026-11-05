import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LOCAL_INFERENCE_MALFORMED_ARGUMENTS_KEY, LocalInferenceAttemptRequestSchema, ObservedLocalModelSchema,
} from '@nessie/executor-protocol'
import { LocalInferenceHostLoop } from '../src/local-inference-host.js'
import { localOpenAiBaseUrl, localOpenAiManifestDigest, parseLocalOpenAiConfig } from '../src/openai-local-config.js'
import { createLocalOpenAiBackend, observeLocalOpenAiModels, type LocalOpenAiFetch } from '../src/openai-local-observed.js'
import { messageForLocalOpenAi, streamLocalOpenAiChat } from '../src/openai-local-chat.js'
import { knownCapabilities, capabilityFor } from '../src/local-inference-host-model.js'
import { apiFor, attempt, coordinatorFixture, HOST_ID, ORG_ID, machineKeys, receiptJournal } from './fixtures/local-inference-host.js'

const config = () => parseLocalOpenAiConfig({
  baseUrl: 'http://localhost:8080/v1', localServiceConfirmed: true,
  models: [{ id: 'local:latest', revision: 'weights-revision-1', contextLength: 262144, maxOutputTokens: 8192, tools: true, thinking: true }],
})
const sse = (frames: unknown[], complete = true) => new Response(
  frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + (complete ? 'data: [DONE]\n\n' : ''),
  { headers: { 'content-type': 'text/event-stream' } },
)
const delta = (content: string) => ({ model: 'local:latest', choices: [{ index: 0, delta: { content } }] })
const terminal = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 3 } }
const input = () => ({ attempt: attempt(), config: config(), origin: 'http://127.0.0.1:8080',
  signal: new AbortController().signal, think: true })
const collect = async <T>(values: AsyncGenerator<T>): Promise<T[]> => {
  const result: T[] = []
  for await (const value of values) result.push(value)
  return result
}

test('endpoint admission supports arbitrary loopback ports and paths without DNS or redirects', () => {
  assert.equal(localOpenAiBaseUrl('http://localhost:8080/v1/'), 'http://127.0.0.1:8080/v1')
  assert.equal(localOpenAiBaseUrl('https://[::1]:443/api/openai/v1'), 'https://[::1]/api/openai/v1')
  for (const value of ['https://example.com/v1', 'http://192.168.1.90:8084/v1', 'file:///tmp/models',
    'http://user:key@localhost:8080/v1', 'http://localhost:8080/v1?target=x', 'http://localhost:8080/v1#x']) {
    assert.throws(() => localOpenAiBaseUrl(value))
  }
})

test('configuration requires owner locality confirmation, immutable revision and explicit capabilities', () => {
  assert.throws(() => parseLocalOpenAiConfig({ ...config(), localServiceConfirmed: false }))
  assert.throws(() => parseLocalOpenAiConfig({ ...config(), models: [{ ...config().models[0], revision: '' }] }))
  assert.throws(() => parseLocalOpenAiConfig({ ...config(), headers: { Authorization: 'unreviewed' } }))
  assert.throws(() => parseLocalOpenAiConfig({ ...config(), apiKey: 'bad\r\nheader' }))
  const a = config()
  assert.equal(localOpenAiManifestDigest(a, a.models[0]!), localOpenAiManifestDigest({ ...a, apiKey: 'private' }, a.models[0]!))
  assert.notEqual(localOpenAiManifestDigest(a, a.models[0]!),
    localOpenAiManifestDigest({ ...a, baseUrl: 'http://127.0.0.1:9999/v1' }, a.models[0]!))
  assert.notEqual(localOpenAiManifestDigest(a, a.models[0]!),
    localOpenAiManifestDigest(a, { ...a.models[0]!, revision: 'weights-revision-2' }))
})

test('discovery publishes only configured models and marks owner-derived identity truthfully', async () => {
  let observedUrl = ''
  let observedInit: RequestInit = {}
  const models = await observeLocalOpenAiModels(config(), async (url, init) => {
    observedUrl = url; observedInit = init
    return new Response(JSON.stringify({ data: [{ id: 'local:latest' }, { id: 'unconsented-model' }] }))
  })
  assert.equal(observedUrl, 'http://127.0.0.1:8080/v1/models')
  assert.equal(observedInit.redirect, 'error')
  assert.equal(models.length, 1)
  assert.equal(models[0]?.identitySource, 'owner_configuration')
  assert.equal(models[0]?.numCtxCap, 262144)
  assert.equal(models[0]?.maxOutputTokens, 8192)
  assert.equal(models[0]?.modelRevision, 'weights-revision-1')
  assert.ok(ObservedLocalModelSchema.safeParse({ ...models[0], capabilities: ['text', 'tools'],
    reportedAt: new Date().toISOString() }).success)
  assert.equal(ObservedLocalModelSchema.safeParse({ ...models[0], capabilities: ['text'],
    maxOutputTokens: 262144, reportedAt: new Date().toISOString() }).success, false)
  assert.ok(LocalInferenceAttemptRequestSchema.safeParse({ ...attempt(), numCtx: 262144 }).success)
  assert.equal(LocalInferenceAttemptRequestSchema.safeParse({ ...attempt(), numCtx: 1000001 }).success, false)
  assert.deepEqual(await observeLocalOpenAiModels(config(), async () =>
    new Response(JSON.stringify({ data: [{ id: 'other' }] }))), [])
  await assert.rejects(observeLocalOpenAiModels(config(), async () => new Response('bad')))
})

test('a Strata served context below the owner configuration fences discovery instead of advertising a false window', async () => {
  await assert.rejects(observeLocalOpenAiModels(config(), async () =>
    new Response(JSON.stringify({ data: [{ id: 'local:latest', meta: { n_ctx: 8192 } }] }))),
  /endpoint_context_exceeds_served/)
  assert.equal((await observeLocalOpenAiModels(config(), async () =>
    new Response(JSON.stringify({ data: [{ id: 'local:latest', meta: { n_ctx: 262144 } }] }))))[0]?.numCtxCap, 262144)
  await assert.rejects(observeLocalOpenAiModels(config(), async () =>
    new Response(JSON.stringify({ data: [{ id: 'local:latest' }, { id: 'local:latest' }] }))))
})

test('chat preserves assistant/tool IDs and accumulates content, reasoning and terminal usage', async () => {
  const a = input()
  let request: Record<string, unknown> = {}
  const events = await collect(streamLocalOpenAiChat({ ...a, fetchImpl: async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:8080/v1/chat/completions')
    assert.equal(init.redirect, 'error')
    assert.equal(init.signal, a.signal)
    request = JSON.parse(String(init.body)) as Record<string, unknown>
    return sse([{ choices: [{ delta: { reasoning_content: 'think' } }] }, delta('hello'), terminal])
  } }))
  assert.equal(request.model, 'local:latest')
  assert.equal(request.max_tokens, 64)
  assert.equal(events[0]?.thinking, 'think')
  assert.equal(events[1]?.text, 'hello')
  assert.deepEqual(events.at(-1), { done: true, finishReason: 'stop', inputTokens: 12, outputTokens: 3 })
  assert.deepEqual(messageForLocalOpenAi({ role: 'tool', content: 'result', toolCallId: 'invocation:openai-1' }),
    { role: 'tool', content: 'result', tool_call_id: 'invocation:openai-1' })
})

test('image bytes require an explicit vision declaration, survive the host, and never fetch a new URL', async () => {
  const c = config()
  const originalDigest = localOpenAiManifestDigest(c, c.models[0]!)
  c.models[0]!.vision = true
  assert.notEqual(localOpenAiManifestDigest(c, c.models[0]!), originalDigest)
  assert.throws(() => parseLocalOpenAiConfig({ ...c, models: [{ ...c.models[0], vision: 'yes' }] }))
  const observed = (await observeLocalOpenAiModels(c, async () =>
    new Response(JSON.stringify({ data: [{ id: 'local:latest' }] }))))[0]!
  assert(knownCapabilities(observed).includes('vision'))
  assert(capabilityFor(attempt(), observed, new Date()).supportsVision)
  assert(!knownCapabilities({ ...observed, identitySource: undefined }).includes('vision'))
  const request = attempt()
  request.modelDigest = localOpenAiManifestDigest(c, c.models[0]!)
  request.messages = [{ role: 'user', content: [
    { type: 'text', text: 'Read the hours' }, { type: 'image', imageUrl: 'data:image/jpeg;base64,YWJj' },
  ] }]
  let posts = 0
  const backend = createLocalOpenAiBackend(async () => c, async (_url, init) => {
    posts++
    const body = JSON.parse(String(init.body)) as { messages: unknown[] }
    assert.deepEqual(body.messages, [{ role: 'user', content: [
      { type: 'text', text: 'Read the hours' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YWJj' } },
    ] }])
    return sse([delta('09:00'), terminal])
  })
  const events = await collect(backend.stream({ ...input(), attempt: request }))
  assert.equal(events[0]?.text, '09:00')
  assert.equal(posts, 1)
  await assert.rejects(collect(createLocalOpenAiBackend(async () => config(), async () => {
    throw new Error('Text-only selection must not invoke the endpoint')
  }).stream({ ...input(), attempt: { ...request, modelDigest: originalDigest } })), /unsupported_capability/)
  assert.throws(() => messageForLocalOpenAi(request.messages[0]!), /unsupported_capability/)
  for (const imageUrl of ['https://example.com/image.jpg', 'http://127.0.0.1/private',
    'file:///C:/private.jpg', 'data:text/plain;base64,YWJj', 'data:image/png;base64,invalid!']) {
    assert.throws(() => messageForLocalOpenAi({ role: 'user', content: [{ type: 'image', imageUrl }] }, true),
      /unsupported_capability/)
  }
})

test('tool-call fragments are bounded and remapped to invocation-scoped IDs', async () => {
  const a = input()
  a.attempt.tools = [{ toolName: 'lookup', description: 'Find record', inputSchema: { type: 'object' } }]
  const events = await collect(streamLocalOpenAiChat({ ...a, fetchImpl: async () => sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'lookup', arguments: '{"id":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '7}' } }] }, finish_reason: 'tool_calls' }] },
  ]) }))
  assert.deepEqual(events.at(-1)?.toolCalls, [{ toolName: 'lookup', arguments: { id: 7 },
    toolCallId: 'invocation-1:openai-1' }])
  // A nameless call is the server's protocol error; a `tool_calls` finish with no call is too.
  for (const frames of [
    [{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }],
    [{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
  ]) {
    await assert.rejects(collect(streamLocalOpenAiChat({ ...a, fetchImpl: async () => sse(frames) })),
      /endpoint_protocol_error/)
  }
})

test('a model\'s slips reach the worker as tool calls it can answer, never as a failed attempt', async () => {
  const a = input()
  a.attempt.tools = [{ toolName: 'lookup', description: 'Find record', inputSchema: { type: 'object' } }]
  // An unknown name and arguments that are not a JSON object are both relayed:
  // the worker's catalog gate answers them with a correctable tool result.
  const events = await collect(streamLocalOpenAiChat({ ...a, fetchImpl: async () => sse([
    { choices: [{ delta: { tool_calls: [
      { index: 0, function: { name: 'made_up_tool', arguments: '{"q":1}' } },
      { index: 1, function: { name: 'lookup', arguments: '{"id": 7,,}' } },
      { index: 2, function: { name: 'lookup', arguments: '' } },
    ] } }] },
    // Strata reports `stop` beside complete tool calls on some turns.
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 9 } },
  ]) }))
  const last = events.at(-1)
  assert.equal(last?.finishReason, 'tool-call')
  assert.deepEqual(last?.toolCalls, [
    { toolName: 'made_up_tool', arguments: { q: 1 }, toolCallId: 'invocation-1:openai-1' },
    { toolName: 'lookup', arguments: { [LOCAL_INFERENCE_MALFORMED_ARGUMENTS_KEY]: '{"id": 7,,}' },
      toolCallId: 'invocation-1:openai-2' },
    { toolName: 'lookup', arguments: {}, toolCallId: 'invocation-1:openai-3' },
  ])
  assert.equal(last?.outputTokens, 9)
})

test('the thinking switch follows the turn and the owner\'s declaration of the model', async () => {
  const bodyFor = async (overrides: { think: boolean; thinkingModel?: boolean; effort?: 'low' | 'high' }) => {
    const a = input()
    a.think = overrides.think
    if (overrides.effort) a.attempt.reasoningEffort = overrides.effort
    let request: Record<string, unknown> = {}
    const thinkingModel = overrides.thinkingModel
    await collect(streamLocalOpenAiChat({ ...a, thinkingModel, fetchImpl: async (_url, init) => {
      request = JSON.parse(String(init.body)) as Record<string, unknown>
      return sse([delta('ok'), terminal])
    } }))
    return request
  }
  // A shown turn asks in the agent's effort; a silent one switches thinking off.
  const shown = await bodyFor({ think: true, thinkingModel: true, effort: 'low' })
  assert.equal(shown.reasoning_effort, 'low')
  assert.equal(shown.chat_template_kwargs, undefined)
  const silent = await bodyFor({ think: false, thinkingModel: true })
  assert.deepEqual(silent.chat_template_kwargs, { enable_thinking: false })
  assert.equal(silent.reasoning_effort, undefined)
  // A shown turn without an effort leaves the server's own default in place.
  assert.equal((await bodyFor({ think: true, thinkingModel: true })).reasoning_effort, undefined)
  // A model the owner did not declare as thinking gets neither field.
  const plain = await bodyFor({ think: false, thinkingModel: false, effort: 'high' })
  assert.equal(plain.reasoning_effort, undefined)
  assert.equal(plain.chat_template_kwargs, undefined)
  // The backend passes the declaration through from the owner's manifest.
  const c = config()
  const a = input()
  a.attempt.modelDigest = localOpenAiManifestDigest(c, c.models[0]!)
  a.attempt.reasoningEffort = 'high'
  let seen: Record<string, unknown> = {}
  await collect(createLocalOpenAiBackend(async () => c, async (_url, init) => {
    seen = JSON.parse(String(init.body)) as Record<string, unknown>
    return sse([delta('ok'), terminal])
  }).stream(a))
  assert.equal(seen.reasoning_effort, 'high')
  assert.ok(LocalInferenceAttemptRequestSchema.safeParse({ ...attempt(), reasoningEffort: 'medium' }).success)
  assert.equal(LocalInferenceAttemptRequestSchema.safeParse({ ...attempt(), reasoningEffort: 'xhigh' }).success, false)
})

test('missing terminal proof, changed model, oversized frames and unavailable endpoints fail closed', async () => {
  for (const response of [
    sse([delta('partial')], false), sse([delta('partial')]), sse([{ ...delta('x'), model: 'wrong' }, terminal]),
    sse([delta('x'.repeat(65536)), terminal]), new Response('unavailable', { status: 503 }),
  ]) {
    await assert.rejects(collect(streamLocalOpenAiChat({ ...input(), fetchImpl: async () => response })))
  }
})

test('blocked request aborts without another request or fallback', async () => {
  const controller = new AbortController()
  let calls = 0
  const task = collect(streamLocalOpenAiChat({ ...input(), signal: controller.signal, fetchImpl: async (_url, init) => {
    calls++
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  } }))
  controller.abort()
  await assert.rejects(task, /cancelled/)
  assert.equal(calls, 1)
})

test('a configuration edit fences a previously consented endpoint/model manifest before invocation', async () => {
  const a = input()
  a.attempt.modelDigest = localOpenAiManifestDigest(a.config, a.config.models[0]!)
  const backend = createLocalOpenAiBackend(async () => ({
    ...a.config, models: [{ ...a.config.models[0]!, revision: 'new-weights' }],
  }), async () => { throw new Error('must not call model') })
  await assert.rejects(collect(backend.stream(a)), /endpoint_model_changed/)
})

test('the signed executor host carries OpenAI inference through ordinary admissions, frames and receipts', async (t) => {
  const c = config()
  const request = attempt()
  request.modelDigest = localOpenAiManifestDigest(c, c.models[0]!)
  let generations = 0
  const fetchImpl: LocalOpenAiFetch = async (url) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'local:latest' }] }))
    generations++
    return sse([delta('hello from endpoint'), terminal])
  }
  const { api, calls } = apiFor(request)
  const loop = new LocalInferenceHostLoop({
    transport: api, backend: createLocalOpenAiBackend(async () => c, fetchImpl),
    coordinator: await coordinatorFixture(t), journal: receiptJournal().journal,
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: machineKeys().privateKey, organizationId: ORG_ID },
    isPaused: () => false, origin: 'http://127.0.0.1:8080',
  })
  await loop.heartbeat()
  assert.deepEqual(await loop.pollOnce(), { attemptId: request.attemptId, kind: 'completed' })
  assert.equal(generations, 1)
  assert.equal(calls.results[0]?.receipt.result.content, 'hello from endpoint')
  assert.equal(calls.results[0]?.receipt.result.modelDigest, request.modelDigest)
  assert.equal(calls.results[0]?.receipt.result.capability.source, 'manual')
  assert.equal(calls.results[0]?.receipt.result.usage.outputTokens, 3)
  assert.ok(calls.frames.length > 0)
})
