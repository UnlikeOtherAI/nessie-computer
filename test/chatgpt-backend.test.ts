import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatgptAuthProvider, ChatgptInferenceSource } from '../src/chatgpt-auth-provider.js'
import { createChatgptBackend } from '../src/chatgpt-backend.js'
import { ChatgptError, chatgptNonacceptanceEvidence } from '../src/chatgpt-errors.js'
import { CHATGPT_MODELS_URL, CHATGPT_RESPONSES_URL } from '../src/chatgpt-http.js'
import { chatgptFunctionName, chatgptRequestBody } from '../src/chatgpt-request.js'
import { chatgptSseData } from '../src/chatgpt-sse.js'
import { composeInferenceBackends, type LocalInferenceBackend } from '../src/local-inference-backend.js'
import { errorResult, publishedModel } from '../src/local-inference-host-model.js'
import {
  LocalInferenceAttemptRequestSchema, LocalInferenceResultSchema, ObservedLocalModelSchema, ProviderMessageSchema,
  type ResponsesContinuation } from '@nessie/executor-protocol'
import { attempt, localResult } from './fixtures/local-inference-host.js'
import { runLocalInferenceGeneration } from '../src/local-inference-generation.js'

const source: ChatgptInferenceSource = { kind: 'chatgpt', processing: 'openai_cloud', billingSource: 'personal_plan',
  profileId: '00000000-0000-4000-8000-000000000001', accountGeneration: 2, consentRevision: 3 }
const authority = (runId: string) => ({
  principal: { serverOrigin: 'https://nessie.example', identityIssuer: 'https://uoa.example',
    organizationId: 'org', teamId: 'team', ownerUserId: 'owner', ownerSubject: 'subject' },
  agent: { kind: 'private' as const, id: 'agent', ownerUserId: 'owner', teamId: 'team' },
  origin: { kind: 'interactive' as const, requestingUserId: 'owner', rootRunId: runId },
  runId, rootRunId: runId, soleReaderUserId: 'owner',
})
const catalogue = () => Response.json({ models: [
  { slug: 'hidden-model', visibility: 'hide' },
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
  { slug: 'future-unknown-capacity', visibility: 'list' },
] })
const terminal = (output: unknown[] = [{ id: 'message-1', type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: 'Hello 👋' }] }]) => ({ type: 'response.completed', response: {
  id: 'response-1', model: 'gpt-6.1-sol', status: 'completed', output, usage: { input_tokens: 40, output_tokens: 7 },
} })
const sse = (events: unknown[]) => {
  const bytes = Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''))
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    // Splitting every byte also splits multibyte UTF-8 and both CRLF characters.
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } })
}
const fixture = () => {
  let ready = true
  let backgroundRevision: number | null = null
  const acquisitions: Array<'discovery' | 'inference'> = []
  let released = 0
  let posts = 0
  let events: unknown[] = [{ type: 'response.output_text.delta', delta: 'Hello ' },
    { type: 'response.output_text.delta', delta: '👋' }, terminal()]
  let posted: Record<string, unknown> | undefined
  let postResponse: (() => Response) | undefined
  const auth: ChatgptAuthProvider = {
    backgroundConsentRevision: async () => backgroundRevision,
    listReadyProfiles: async () => ready ? [source] : [],
    acquireAccess: async (input) => {
      acquisitions.push(input.purpose)
      assert.deepEqual(input.source, source)
      if (input.purpose === 'inference') assert.equal(input.attempt.inferenceSource?.kind, 'chatgpt')
      return { accessToken: 'test-only-oauth-token', signal: input.signal, release: async () => { released++ } }
    },
  }
  const backend = createChatgptBackend(auth, { fetchImpl: async (url, init) => {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-only-oauth-token')
    assert.equal(init.redirect, 'error')
    if (url === CHATGPT_MODELS_URL) return catalogue()
    assert.equal(url, CHATGPT_RESPONSES_URL)
    posts++; posted = JSON.parse(String(init.body)) as Record<string, unknown>
    return postResponse?.() ?? sse(events)
  } })
  const input = async () => {
    const model = (await backend.observe())[0]!
    const call = attempt()
    delete call.maxOutputTokens
    Object.assign(call, { inferenceSource: source, modelName: model.name,
      modelDigest: model.manifestDigest, numCtx: 1_000_000 })
    return { attempt: LocalInferenceAttemptRequestSchema.parse({
      ...call, personalAuthority: authority(call.runId),
    }), origin: 'http://127.0.0.1:11434',
      signal: new AbortController().signal, think: true }
  }
  return { backend, input, acquisitions, get released() { return released }, get posts() { return posts },
    background: (revision: number | null) => { backgroundRevision = revision },
    get posted() { return posted }, setEvents: (value: unknown[]) => { events = value },
    disable: () => { ready = false },
    setPostResponse: (value: () => Response) => { postResponse = value } }
}

test('live background publication changes without replacing the foreground model or disclosure consent', async () => {
  const f = fixture()
  const initial = (await f.backend.observe())[0]!
  assert.equal(initial.personalBackgroundConsentRevision, null)
  f.background(7)
  const enabled = (await f.backend.observe())[0]!
  const published = ObservedLocalModelSchema.parse(publishedModel(enabled, new Date().toISOString()))
  assert.equal(published.personalBackgroundConsentRevision, 7)
  assert.equal(enabled.manifestDigest, initial.manifestDigest)
  assert.deepEqual(enabled.inferenceSource, initial.inferenceSource)
  f.background(null)
  const withdrawn = (await f.backend.observe())[0]!
  assert.equal(withdrawn.personalBackgroundConsentRevision, null)
  assert.equal(withdrawn.name, initial.name)
  assert.equal(f.posts, 0)
})

test('visible catalogue preserves verified capacity/source and refuses unverified slugs', async () => {
  const f = fixture()
  const models = await f.backend.observe()
  assert.equal(models.length, 1)
  assert.equal(models[0]?.providerModelId, 'gpt-6.1-sol')
  assert.equal(models[0]?.displayName, 'GPT-6.1 Sol')
  assert.equal(models[0]?.numCtxCap, 1_050_000)
  assert.equal(models[0]?.maxOutputTokens, 128_000)
  assert.equal(ObservedLocalModelSchema.safeParse(publishedModel(models[0]!, new Date().toISOString())).success, true)
  assert.equal(JSON.stringify(models).includes('test-only-oauth-token'), false)
  assert.equal(f.released, 1)
  f.disable()
  assert.deepEqual(await f.backend.observe(), [])
})

test('uncapped reference-model call sends one public Responses request and exact usage', async () => {
  const f = fixture()
  const events = []
  for await (const event of f.backend.stream(await f.input())) events.push(event)
  assert.equal(events.filter((event) => event.done).length, 1)
  assert.equal(events.at(-1)?.inputTokens, 40)
  assert.equal(events.at(-1)?.outputTokens, 7)
  assert.equal(events.map((event) => event.text ?? '').join(''), 'Hello 👋')
  assert.equal(f.posts, 1)
  assert.equal(f.released, 2)
  assert.equal(f.posted?.model, 'gpt-6.1-sol')
  assert.equal(f.posted?.store, false)
  assert.equal(f.posted?.stream, true)
  for (const key of ['max_output_tokens', 'temperature', 'top_p', 'metadata', 'previous_response_id', 'truncation']) {
    assert.equal(Object.hasOwn(f.posted!, key), false)
  }
})

test('lower hard cap refuses before auth or network; natural provider maximum is not a client token cap', async () => {
  const f = fixture()
  const input = await f.input()
  input.attempt.maxOutputTokens = 1000
  await assert.rejects(async () => { for await (const event of f.backend.stream(input)) { void event } },
    { code: 'chatgpt_output_cap_unsupported', outcome: 'not_sent' })
  assert.deepEqual(f.acquisitions, ['discovery'])
  assert.equal(f.posts, 0)
})

test('namespaced tool definitions and fragmented arguments retain original identity', async () => {
  const f = fixture()
  const input = await f.input()
  const toolName = 'mcp/CRM.čti_klienta'
  input.attempt.tools = [{ toolName, description: 'Read a customer', inputSchema: { type: 'object' } }]
  input.attempt.messages.unshift({ role: 'system', content: 'Private approved policy' })
  input.attempt.messages.push({ role: 'assistant', content: null,
    toolCalls: [{ toolName, toolCallId: 'prior-call', arguments: { id: 2 } }],
    responsesContinuation: { version: 1, inferenceSource: source, providerModelId: 'gpt-6.1-sol',
      rootRunId: input.attempt.runId, outputItemsJson: JSON.stringify([{ id: 'prior-function', type: 'function_call',
        call_id: 'prior-call', name: chatgptFunctionName(toolName), namespace: 'nessie', arguments: '{"id":2}' }]) } },
  { role: 'tool', toolCallId: 'prior-call', content: 'prior result' })
  const item = { id: 'function-1', type: 'function_call', call_id: 'call-1', namespace: 'nessie',
    name: chatgptFunctionName(toolName), arguments: '' }
  f.setEvents([{ type: 'response.output_item.added', item },
    { type: 'response.function_call_arguments.delta', item_id: item.id, delta: '{"id":' },
    { type: 'response.function_call_arguments.delta', item_id: item.id, delta: '42}' },
    terminal([{ ...item, arguments: '{"id":42}' }])])
  let last
  for await (const event of f.backend.stream(input)) last = event
  assert.deepEqual(last?.toolCalls, [{ toolName, toolCallId: 'call-1', arguments: { id: 42 } }])
  const namespace = (f.posted?.tools as Array<Record<string, unknown>>)[0]!
  assert.equal(namespace.type, 'namespace')
  assert.equal(namespace.name, 'nessie')
  assert.equal((namespace.tools as Array<Record<string, unknown>>)[0]?.name, chatgptFunctionName(toolName))
  assert.equal(f.posted?.instructions, 'Private approved policy')
  const replay = (f.posted?.input as Array<Record<string, unknown>>).find((item) => item.type === 'function_call')
  assert.equal(replay?.namespace, 'nessie')
  assert.equal(replay?.name, chatgptFunctionName(toolName))
})

for (const [label, events] of [
  ['EOF without terminal', [{ type: 'response.output_text.delta', delta: 'partial' }]],
  ['incomplete', [{ type: 'response.incomplete', response: { status: 'incomplete' } }]],
  ['quota failure after stream opened', [{ type: 'response.failed', response: {
    error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private-provider-diagnostic' },
  } }]],
  ['invalid usage', [{ ...terminal(), response: { ...terminal().response,
    usage: { input_tokens: 4, output_tokens: -1 } } }]],
  ['missing tool identity', [{ type: 'response.function_call_arguments.delta',
    item_id: 'not-announced', delta: '{}' }]],
] as const) test(`${label} never succeeds or automatically repeats an accepted request`, async () => {
  const f = fixture()
  f.setEvents([...events])
  await assert.rejects(async () => { for await (const event of f.backend.stream(await f.input())) { void event } },
    (error: unknown) => error instanceof ChatgptError && error.outcome === 'unknown'
      && !error.message.includes('private-provider-diagnostic'))
  assert.equal(f.posts, 1)
  assert.equal(f.released, 2)
})

test('profile revocation and independent discovery failures never choose another source', async () => {
  const f = fixture()
  const input = await f.input()
  f.disable()
  await assert.rejects(async () => { for await (const event of f.backend.stream(input)) { void event } },
    { code: 'chatgpt_needs_sign_in', outcome: 'not_sent' })
  assert.equal(f.posts, 0)
  const local: LocalInferenceBackend = { observe: async () => { throw new Error('Ollama offline') },
    stream: async function* () { yield { done: false }; throw new Error('must not fall back to Ollama') } }
  const cloudModel = (await fixture().backend.observe())[0]!
  const cloud: LocalInferenceBackend = { observe: async () => [cloudModel],
    stream: async function* () { yield { done: false }; throw new ChatgptError('chatgpt_usage_unknown', 'unknown') } }
  const composed = composeInferenceBackends(local, cloud)
  assert.deepEqual(await composed.observe(), [cloudModel])
  await assert.rejects(async () => { for await (const event of composed.stream(input)) { void event } },
    { code: 'chatgpt_usage_unknown' })
  assert.deepEqual(await composeInferenceBackends({ ...local, observe: async () => [{ ...cloudModel,
    name: 'local-model', inferenceSource: { kind: 'local_weights' } }] }, {
    ...cloud, observe: async () => { throw new Error('ChatGPT unavailable') },
  }).observe(), [{ ...cloudModel, name: 'local-model', inferenceSource: { kind: 'local_weights' } }])
})

test('request mapping refuses unsupported multimodal history instead of dropping it', async () => {
  const f = fixture()
  const input = await f.input()
  const model = (await f.backend.observe())[0]!
  input.attempt.messages = [{ role: 'assistant', content: [
    { type: 'image', imageUrl: 'https://example.invalid/image' },
  ] }]
  assert.throws(() => chatgptRequestBody(input.attempt, model as import('../src/chatgpt-models.js').ChatgptModel),
    { code: 'chatgpt_unsupported_capability', outcome: 'not_sent' })
})

test('SSE accepts multiline JSON, cancels blocked reads and rejects oversized or incomplete events', async () => {
  const controller = new AbortController()
  const multiline = new Response('data: {"type":\ndata: "response.completed"}\n\n')
  const frames: string[] = []
  for await (const frame of chatgptSseData(multiline, controller.signal)) frames.push(frame)
  assert.deepEqual(JSON.parse(frames[0]!), { type: 'response.completed' })
  let cancelled = false
  const blocked = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }))
  const reading = chatgptSseData(blocked, controller.signal).next()
  controller.abort()
  await assert.rejects(reading, { code: 'chatgpt_cancelled', outcome: 'unknown' })
  assert.equal(cancelled, true)
  for (const body of ['data: unfinished', `data: ${'x'.repeat(4 * 1024 * 1024 + 1)}\n\n`]) {
    await assert.rejects(async () => {
      for await (const frame of chatgptSseData(new Response(body), new AbortController().signal)) void frame
    }, { code: 'chatgpt_protocol_error', outcome: 'unknown' })
  }
})

test('completed refusal settles actual usage; conflicting streamed tool identity remains unknown', async () => {
  const f = fixture()
  f.setEvents([{ type: 'response.refusal.delta', delta: 'Cannot do that.' }, terminal([
    { id: 'message-1', type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot do that.' }] },
  ])])
  const refusal = []
  for await (const event of f.backend.stream(await f.input())) refusal.push(event)
  assert.equal(refusal.at(-1)?.outputTokens, 7)
  const input = await f.input()
  input.attempt.tools = [{ toolName: 'read', description: 'Read', inputSchema: { type: 'object' } }]
  const item = { id: 'function-1', type: 'function_call', call_id: 'call-1', namespace: 'nessie',
    name: chatgptFunctionName('read'), arguments: '{}' }
  f.setEvents([{ type: 'response.output_item.added', item }, terminal([{ ...item, id: 'different-id' }])])
  await assert.rejects(async () => { for await (const event of f.backend.stream(input)) void event },
    { code: 'chatgpt_protocol_error', outcome: 'unknown' })
})

for (const [label, response] of [
  ['server error after POST', () => Response.json({ error: { code: 'server_error', message: 'private diagnostic' } },
    { status: 500 })],
  ['timeout after POST', () => Response.json({ error: { code: 'timeout' } }, { status: 408 })],
  ['malformed rejection envelope', () => new Response('private diagnostic', { status: 400 })],
  ['oversized rejection envelope', () => new Response('x'.repeat(1024 * 1024 + 1), { status: 429 })],
] as const) test(`${label} retains unknown liability with no replay`, async () => {
  const f = fixture()
  f.setPostResponse(response)
  await assert.rejects(async () => { for await (const event of f.backend.stream(await f.input())) void event },
    (error: unknown) => error instanceof ChatgptError && error.outcome === 'unknown'
      && !error.message.includes('private'))
  assert.equal(f.posts, 1)
  assert.equal(f.released, 2)
})

test('explicit effort survives disabled thinking display; invalid efforts refuse before inference auth', async () => {
  const f = fixture()
  const input = await f.input()
  input.attempt.thinking = false
  input.attempt.reasoningEffort = 'high'
  for await (const event of f.backend.stream(input)) void event
  assert.deepEqual(f.posted?.reasoning, { effort: 'high' })
  Object.assign(input.attempt, { reasoningEffort: 'ultra' })
  await assert.rejects(async () => { for await (const event of f.backend.stream(input)) void event },
    { code: 'chatgpt_unsupported_capability', outcome: 'not_sent' })
  assert.equal(f.posts, 1)
})

test('explicit none is refused before inference access and never becomes the provider default', async () => {
  const f = fixture()
  const input = await f.input()
  input.attempt.thinking = false
  Object.assign(input.attempt, { reasoningEffort: 'none' })
  await assert.rejects(async () => { for await (const event of f.backend.stream(input)) void event },
    { code: 'chatgpt_unsupported_capability', outcome: 'not_sent' })
  assert.deepEqual(f.acquisitions, ['discovery'])
  assert.equal(f.posts, 0)
})

test('two serialized tool turns preserve encrypted reasoning and ordered phases', async () => {
  const f = fixture()
  const input = await f.input()
  input.attempt.tools = [{ toolName: 'read', description: 'Read', inputSchema: { type: 'object' } }]
  const items = [{ id: 'reasoning-1', type: 'reasoning', encrypted_content: 'opaque-test-ciphertext', summary: [] },
    { id: 'commentary-1', type: 'message', role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: 'Working.' }] },
    { id: 'function-1', type: 'function_call', call_id: 'call-1', namespace: 'nessie',
      name: chatgptFunctionName('read'), arguments: '{"id":42}' }]
  f.setEvents([terminal(items)])
  const generated = await runLocalInferenceGeneration({ ...input, stream: f.backend.stream,
    capability: () => localResult().capability, publish: () => undefined, terminal: async () => undefined })
  const serialized = LocalInferenceResultSchema.parse(JSON.parse(JSON.stringify(generated)))
  assert.equal(serialized.reasoning, null)
  assert.equal(serialized.content, 'Working.')
  assert.deepEqual(JSON.parse(serialized.responsesContinuation!.outputItemsJson), items)
  const message = ProviderMessageSchema.parse(JSON.parse(JSON.stringify({
    role: 'assistant', content: serialized.content,
    toolCalls: serialized.toolCalls, responsesContinuation: serialized.responsesContinuation })))
  input.attempt.messages.push(message, { role: 'tool', toolCallId: 'call-1', content: 'Tool returned 42' })
  f.setEvents([terminal([{ id: 'final-1', type: 'message', role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: 'Hello 👋' }] }])])
  input.attempt = LocalInferenceAttemptRequestSchema.parse(JSON.parse(JSON.stringify(input.attempt)))
  for await (const event of f.backend.stream(input)) void event
  assert.equal(f.posts, 2)
  assert.deepEqual((f.posted?.input as unknown[]).slice(1, 4), items)
  assert.deepEqual((f.posted?.input as unknown[])[4], {
    type: 'function_call_output', call_id: 'call-1', output: 'Tool returned 42',
  })
  assert.deepEqual(f.posted?.include, ['reasoning.encrypted_content'])
  assert.equal(Object.hasOwn(f.posted!, 'previous_response_id'), false)
  for (const override of [
    { inferenceSource: { ...source, profileId: '00000000-0000-4000-8000-000000000002' } },
    { inferenceSource: { ...source, accountGeneration: 3 } },
    { inferenceSource: { ...source, consentRevision: 4 } },
    { providerModelId: 'other-model' }, { rootRunId: 'other-root' },
  ]) {
    if (message.role !== 'assistant') return assert.fail('assistant message required')
    const resumedMessage = input.attempt.messages.find((item) => item.role === 'assistant')
    if (!resumedMessage || resumedMessage.role !== 'assistant') return assert.fail('resumed assistant required')
    resumedMessage.responsesContinuation = {
      ...serialized.responsesContinuation!, ...override,
    } as ResponsesContinuation
    await assert.rejects(async () => { for await (const event of f.backend.stream(input)) void event },
      { code: 'chatgpt_protocol_error', outcome: 'not_sent' })
  }
  assert.equal(f.posts, 2)
})

for (const raw of ['[1]', 'null', '1', '"string"', '{bad-json']) {
  test(`a correctable non-object tool call ${raw} replays its exact provider arguments`, async () => {
    const f = fixture()
    const input = await f.input()
    input.attempt.tools = [{ toolName: 'read', description: 'Read', inputSchema: { type: 'object' } }]
    const item = { id: 'function-1', type: 'function_call', call_id: 'call-1', namespace: 'nessie',
      name: chatgptFunctionName('read'), arguments: raw }
    f.setEvents([terminal([
      { id: 'reasoning-1', type: 'reasoning', encrypted_content: 'opaque-ciphertext', summary: [] }, item,
    ])])
    let result
    for await (const event of f.backend.stream(input)) result = event
    assert.deepEqual(result?.toolCalls?.[0]?.arguments, { _malformedArguments: raw })
    input.attempt.messages.push(ProviderMessageSchema.parse(JSON.parse(JSON.stringify({
      role: 'assistant', content: null,
      toolCalls: result!.toolCalls, responsesContinuation: result!.responsesContinuation }))),
    { role: 'tool', toolCallId: 'call-1',
      content: 'Tool arguments must be a JSON object. Please correct the arguments.' })
    f.setEvents([terminal()])
    for await (const event of f.backend.stream(input)) void event
    assert.equal(f.posts, 2)
    const replay = (f.posted?.input as Array<Record<string, unknown>>).find((entry) => entry.type === 'function_call')
    assert.equal(replay?.arguments, raw)
    assert.equal(String(replay?.arguments).includes('_malformedArguments'), false)
  })
}


for (const status of [401, 403, 429] as const) test(`HTTP ${status} produces scoped nonacceptance, no usage`, async () => {
  const f = fixture()
  const input = await f.input()
  const model = (await f.backend.observe())[0]!
  f.setPostResponse(() => Response.json({ error: { code: 'invalid_token' } }, { status }))
  let failure: unknown
  try { for await (const event of f.backend.stream(input)) void event } catch (error) { failure = error }
  assert.deepEqual(chatgptNonacceptanceEvidence(failure), {
    kind: 'rejected', httpStatus: status, structuredError: true })
  const receipt = LocalInferenceResultSchema.parse(JSON.parse(JSON.stringify(errorResult(
    input.attempt, model, new Date(), failure,
  ))))
  assert.deepEqual(receipt.personalNonacceptance, { kind: 'rejected', httpStatus: status, structuredError: true })
  assert.deepEqual(receipt.usage, { inputTokens: null, outputTokens: null })
  assert.equal(f.posts, 1)
  assert.equal(chatgptNonacceptanceEvidence(new Error('invalid_token')), undefined)
  assert.equal(chatgptNonacceptanceEvidence(new ChatgptError('chatgpt_usage_unknown', 'unknown', 500)), undefined)
})
