import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LOCAL_INFERENCE_MALFORMED_ARGUMENTS_KEY, LocalInferenceAttemptRequestSchema, ObservedLocalModelSchema,
} from '@nessie/executor-protocol'
import { LocalInferenceHostLoop } from '../src/local-inference-host.js'
import { localOpenAiBaseUrl, parseLocalOpenAiConfig } from '../src/openai-local-config.js'
import {
  createLocalOpenAiBackend, observeLocalOpenAiModels, readReportedModels, reportedModelDigest, type LocalOpenAiFetch,
} from '../src/openai-local-observed.js'
import { messageForLocalOpenAi, streamLocalOpenAiChat } from '../src/openai-local-chat.js'
import { knownCapabilities, capabilityFor } from '../src/local-inference-host-model.js'
import { apiFor, attempt, coordinatorFixture, HOST_ID, ORG_ID, machineKeys, receiptJournal } from './fixtures/local-inference-host.js'

const config = () => parseLocalOpenAiConfig({ baseUrl: 'http://localhost:8080/v1', localServiceConfirmed: true })
/** What Strata and llama.cpp report about the one model they serve. */
const strataProps = {
  default_generation_settings: { n_ctx: 262144, params: { n_predict: -1 } }, model_alias: 'local:latest',
  chat_template_caps: { supports_tools: true }, modalities: { vision: true },
  chat_template: '{%- if enable_thinking is defined and enable_thinking is false %}', model_path: 'C:/models/a.gguf',
}
const strataListing = [{ id: 'local:latest', meta: { n_ctx: 262144 },
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }]
const notFound = () => new Response('{"error":{"message":"not found"}}', { status: 404 })
/** A local server: its listing, its props (null when it has none), and its chat answer. */
const server = (listing: unknown[] = strataListing, props: unknown = strataProps,
  chat?: (url: string, init: RequestInit) => Promise<Response>): LocalOpenAiFetch => async (url, init) => {
  if (url.endsWith('/models')) return new Response(JSON.stringify({ data: listing }))
  if (url.endsWith('/props')) return props === null ? notFound() : new Response(JSON.stringify(props))
  if (chat && url.endsWith('/chat/completions')) return chat(url, init)
  throw new Error(`unexpected request ${url}`)
}
const strataDigest = async (fetchImpl: LocalOpenAiFetch = server()) => {
  const [model] = await readReportedModels(config(), fetchImpl)
  return reportedModelDigest(config(), model!)
}
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

test('configuration names only the address and the owner\'s locality confirmation', () => {
  assert.throws(() => parseLocalOpenAiConfig({ ...config(), localServiceConfirmed: false }))
  assert.throws(() => parseLocalOpenAiConfig({ ...config(), headers: { Authorization: 'unreviewed' } }))
  assert.throws(() => parseLocalOpenAiConfig({ ...config(), apiKey: 'bad\r\nheader' }))
  // A model list saved by an earlier release is read past: the server now describes its models.
  assert.deepEqual(parseLocalOpenAiConfig({ ...config(), models: [{ id: 'local:latest', contextLength: 8192 }] }),
    config())
  assert.deepEqual(parseLocalOpenAiConfig({ baseUrl: 'http://localhost:8080', localServiceConfirmed: true }),
    { baseUrl: 'http://127.0.0.1:8080', localServiceConfirmed: true })
})

test('discovery publishes every model with the context and capabilities its server reports', async () => {
  const requested: string[] = []
  let observedInit: RequestInit = {}
  const models = await observeLocalOpenAiModels(config(), async (url, init) => {
    requested.push(url); observedInit = init
    return server()(url, init)
  })
  assert.deepEqual(requested, ['http://127.0.0.1:8080/v1/models', 'http://127.0.0.1:8080/props'])
  assert.equal(observedInit.redirect, 'error')
  assert.equal(models.length, 1)
  assert.equal(models[0]?.identitySource, 'owner_configuration')
  assert.equal(models[0]?.numCtxCap, 262144)
  assert.equal(models[0]?.maxOutputTokens, undefined)
  assert.deepEqual(models[0]?.capabilities, ['completion', 'tools', 'thinking', 'vision'])
  assert.deepEqual(knownCapabilities(models[0]!), ['text', 'tools', 'thinking', 'vision'])
  assert.ok(ObservedLocalModelSchema.safeParse({ ...models[0], capabilities: ['text', 'tools'],
    reportedAt: new Date().toISOString() }).success)
  assert.equal(ObservedLocalModelSchema.safeParse({ ...models[0], capabilities: ['text'],
    maxOutputTokens: 262144, reportedAt: new Date().toISOString() }).success, false)
  // A server that reports no context publishes it unknown, for Nessie to ask its owner.
  const unknown = await observeLocalOpenAiModels(config(), server([{ id: 'plain' }], null))
  assert.deepEqual(unknown.map((model) => [model.numCtxCap, model.capabilities]), [[null, ['completion']]])
  assert.ok(ObservedLocalModelSchema.safeParse({ ...unknown[0], capabilities: ['text'],
    reportedAt: new Date().toISOString() }).success)
  assert.ok(LocalInferenceAttemptRequestSchema.safeParse({ ...attempt(), numCtx: 262144 }).success)
  assert.equal(LocalInferenceAttemptRequestSchema.safeParse({ ...attempt(), numCtx: 1000001 }).success, false)
  await assert.rejects(observeLocalOpenAiModels(config(), async () => new Response('bad')))
  await assert.rejects(observeLocalOpenAiModels(config(), server([{ id: 'twice' }, { id: 'twice' }])))
})

test('the served context is bounded by the model\'s own, and other servers\' listings are read too', async () => {
  const context = async (listing: unknown[], props: unknown = null) =>
    (await observeLocalOpenAiModels(config(), server(listing, props))).map((model) => model.numCtxCap)
  // llama.cpp serves what it allocated, never beyond what the model was trained for.
  assert.deepEqual(await context([{ id: 'a', meta: { n_ctx_train: 131072 } }],
    { ...strataProps, model_alias: 'a' }), [131072])
  assert.deepEqual(await context([{ id: 'a', meta: { n_ctx_train: 131072, n_ctx: 32768 } }]), [32768])
  // The training context alone is not what the server allocated.
  assert.deepEqual(await context([{ id: 'a', meta: { n_ctx_train: 131072 } }]), [null])
  assert.deepEqual(await context([{ id: 'vllm', max_model_len: 40960 }]), [40960])
  assert.deepEqual(await context([{ id: 'router', context_length: 65536, supported_parameters: ['tools'] }]), [65536])
  assert.deepEqual(await context([{ id: 'huge', meta: { n_ctx: 4_000_000 } }]), [1_000_000])
  // An embedding model produces no text and is not a chat model.
  assert.deepEqual(await context([{ id: 'embed', architecture: { output_modalities: ['embeddings'] } }]), [])
  // Props describe the one loaded model; a router's other models get the listing alone.
  const routed = await observeLocalOpenAiModels(config(), server([{ id: 'local:latest' }, { id: 'other' }]))
  assert.deepEqual(routed.map((model) => [model.name, model.numCtxCap, model.capabilities.length]),
    [['local:latest', 262144, 4], ['other', null, 1]])
  // A positive generation limit is the server's output limit.
  const limited = await observeLocalOpenAiModels(config(), server(strataListing,
    { ...strataProps, default_generation_settings: { n_ctx: 262144, params: { n_predict: 8192 } } }))
  assert.equal(limited[0]?.maxOutputTokens, 8192)
})

test('a server named by its port alone is asked under /v1 and described at its own root', async () => {
  const requested: string[] = []
  const portOnly = parseLocalOpenAiConfig({ baseUrl: 'http://127.0.0.1:8080', localServiceConfirmed: true })
  await observeLocalOpenAiModels(portOnly, async (url, init) => { requested.push(url); return server()(url, init) })
  assert.deepEqual(requested, ['http://127.0.0.1:8080/v1/models', 'http://127.0.0.1:8080/props'])
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

test('images go to a model whose server reports vision, survive the host, and never fetch a new URL', async () => {
  const textProps = { ...strataProps, modalities: { vision: false } }
  const textOnly = [{ id: 'local:latest', meta: { n_ctx: 262144 } }]
  const visionDigest = await strataDigest()
  const textDigest = await strataDigest(server(textOnly, textProps))
  assert.notEqual(visionDigest, textDigest)
  const observed = (await observeLocalOpenAiModels(config(), server()))[0]!
  assert(knownCapabilities(observed).includes('vision'))
  assert(capabilityFor(attempt(), observed, new Date()).supportsVision)
  assert.equal(capabilityFor(attempt(), observed, new Date()).source, 'live')
  // An observed Ollama model that reports vision is published with it too; its transport carries images.
  assert(knownCapabilities({ ...observed, identitySource: undefined }).includes('vision'))
  const request = attempt()
  request.modelDigest = visionDigest
  request.messages = [{ role: 'user', content: [
    { type: 'text', text: 'Read the hours' }, { type: 'image', imageUrl: 'data:image/jpeg;base64,YWJj' },
  ] }]
  let posts = 0
  const backend = createLocalOpenAiBackend(async () => config(), server(undefined, undefined, async (_url, init) => {
    posts++
    const body = JSON.parse(String(init.body)) as { messages: unknown[] }
    assert.deepEqual(body.messages, [{ role: 'user', content: [
      { type: 'text', text: 'Read the hours' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YWJj' } },
    ] }])
    return sse([delta('09:00'), terminal])
  }))
  const events = await collect(backend.stream({ ...input(), attempt: request }))
  assert.equal(events[0]?.text, '09:00')
  assert.equal(posts, 1)
  // A model whose server reports no vision refuses the image before anything is sent.
  await assert.rejects(collect(createLocalOpenAiBackend(async () => config(), server(textOnly, textProps, async () => {
    throw new Error('Text-only selection must not invoke the endpoint')
  })).stream({ ...input(), attempt: { ...request, modelDigest: textDigest } })), /unsupported_capability/)
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

test('the thinking switch follows the turn and whether the server\'s template takes it', async () => {
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
  // A model whose template takes no thinking switch gets neither field.
  const plain = await bodyFor({ think: false, thinkingModel: false, effort: 'high' })
  assert.equal(plain.reasoning_effort, undefined)
  assert.equal(plain.chat_template_kwargs, undefined)
  // The backend switches thinking only for a model whose chat template takes the switch.
  const a = input()
  a.attempt.modelDigest = await strataDigest()
  a.attempt.reasoningEffort = 'high'
  let seen: Record<string, unknown> = {}
  await collect(createLocalOpenAiBackend(async () => config(), server(undefined, undefined, async (_url, init) => {
    seen = JSON.parse(String(init.body)) as Record<string, unknown>
    return sse([delta('ok'), terminal])
  })).stream(a))
  assert.equal(seen.reasoning_effort, 'high')
  const plainProps = { ...strataProps, chat_template: '{{ messages }}' }
  a.attempt.modelDigest = await strataDigest(server(undefined, plainProps))
  await collect(createLocalOpenAiBackend(async () => config(), server(undefined, plainProps, async (_url, init) => {
    seen = JSON.parse(String(init.body)) as Record<string, unknown>
    return sse([delta('ok'), terminal])
  })).stream(a))
  assert.equal(seen.reasoning_effort, undefined)
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

test('a server that changes the model behind a name fences the consented pin before invocation', async () => {
  const a = input()
  a.attempt.modelDigest = await strataDigest()
  for (const props of [{ ...strataProps, model_path: 'C:/models/b.gguf' },
    { ...strataProps, default_generation_settings: { n_ctx: 65536, params: {} } }]) {
    const backend = createLocalOpenAiBackend(async () => config(), server([{ id: 'local:latest' }], props, async () => {
      throw new Error('must not call model')
    }))
    await assert.rejects(collect(backend.stream(a)), /endpoint_model_changed/)
  }
  await assert.rejects(collect(createLocalOpenAiBackend(async () => null, server()).stream(a)),
    /endpoint_model_changed/)
})

test('the signed executor host carries OpenAI inference through ordinary admissions, frames and receipts', async (t) => {
  const request = attempt()
  request.modelDigest = await strataDigest()
  let generations = 0
  const fetchImpl = server(undefined, undefined, async () => {
    generations++
    return sse([delta('hello from endpoint'), terminal])
  })
  const { api, calls } = apiFor(request)
  const loop = new LocalInferenceHostLoop({
    transport: api, backend: createLocalOpenAiBackend(async () => config(), fetchImpl),
    coordinator: await coordinatorFixture(t), journal: receiptJournal().journal,
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: machineKeys().privateKey, organizationId: ORG_ID },
    isPaused: () => false, origin: 'http://127.0.0.1:8080',
  })
  await loop.heartbeat()
  assert.deepEqual(await loop.pollOnce(), { attemptId: request.attemptId, kind: 'completed' })
  assert.equal(generations, 1)
  assert.equal(calls.results[0]?.receipt.result.content, 'hello from endpoint')
  assert.equal(calls.results[0]?.receipt.result.modelDigest, request.modelDigest)
  assert.equal(calls.results[0]?.receipt.result.capability.source, 'live')
  assert.equal(calls.results[0]?.receipt.result.usage.outputTokens, 3)
  assert.ok(calls.frames.length > 0)
})
