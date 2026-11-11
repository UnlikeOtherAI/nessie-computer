import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalInferenceAttemptRequestSchema, type ExecutorChatgptContext } from '@nessie/executor-protocol'
import type { ChatgptAuthProvider, ChatgptInferenceSource } from '../src/chatgpt-auth-provider.js'
import { CHATGPT_INVENTORY_TTL_MS, createChatgptBackend } from '../src/chatgpt-backend.js'
import { CHATGPT_PERSONAL_MODELS_URL, CHATGPT_PERSONAL_RESPONSES_URL } from '../src/chatgpt-http.js'
import { chatgptPromptCacheKey } from '../src/chatgpt-request.js'
import { CHATGPT_AUTHORITY_MAX_AGE_MS, shareChatgptAuthority } from '../src/chatgpt-shared-authority.js'
import { attempt } from './fixtures/local-inference-host.js'

// What one model turn costs beyond its own request: how often the provider's
// model list is read and how often Nessie is asked to re-prove the owner.
const source: ChatgptInferenceSource = { kind: 'chatgpt', processing: 'openai_cloud', billingSource: 'personal_plan',
  profileId: '00000000-0000-4000-8000-000000000001', accountGeneration: 2, consentRevision: 3 }
const authority = (runId: string) => ({
  principal: { serverOrigin: 'https://nessie.example', identityIssuer: 'https://uoa.example',
    organizationId: 'org', teamId: 'team', ownerUserId: 'owner', ownerSubject: 'subject' },
  agent: { kind: 'private' as const, id: 'agent', ownerUserId: 'owner', teamId: 'team' },
  origin: { kind: 'interactive' as const, requestingUserId: 'owner', rootRunId: runId },
  runId, rootRunId: runId, soleReaderUserId: 'owner',
})
const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } })
const completed = (model: unknown) => ({ type: 'response.completed', response: { id: 'response-1', model,
  status: 'completed', usage: { input_tokens: 40, output_tokens: 7 },
  output: [{ id: 'message-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] }] } })

const fixture = (options: { inventoryTtlMs?: number } = {}) => {
  let clock = 1_000_000
  let listed = 0
  let slugs = ['gpt-6.1-sol', 'gpt-6.1-luna']
  let listFails = false
  let postStatus = 200
  const acquisitions: string[] = []
  const posted: Array<Record<string, unknown>> = []
  const auth: ChatgptAuthProvider = {
    listReadyProfiles: async () => [source],
    acquireAccess: async (input) => {
      acquisitions.push(input.purpose)
      return { accessToken: 'test-only-oauth-token', accountId: 'account-main', signal: input.signal,
        release: async () => undefined }
    },
  }
  const backend = createChatgptBackend(auth, { now: () => clock, ...options, fetchImpl: async (url, init) => {
    if (url === CHATGPT_PERSONAL_MODELS_URL) {
      listed++
      if (listFails) return Response.json({ error: { code: 'server_error' } }, { status: 503 })
      return Response.json({ models: slugs.map((slug) => ({ slug, display_name: slug,
        context_window: 400_000, max_output_tokens: 128_000, visibility: 'list' })) })
    }
    assert.equal(url, CHATGPT_PERSONAL_RESPONSES_URL)
    posted.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return postStatus === 200 ? sse([completed(posted.at(-1)?.model)])
      : Response.json({ error: { code: 'server_error' } }, { status: postStatus })
  } })
  const input = async (name = 'gpt-6.1-sol', bindingId?: string) => {
    const model = (await backend.observe()).find((candidate) => candidate.providerModelId === name)!
    const call = attempt()
    delete call.maxOutputTokens
    Object.assign(call, { inferenceSource: source, modelName: model.name, modelDigest: model.manifestDigest,
      numCtx: 200_000, ...(bindingId ? { bindingId } : {}) })
    return { attempt: LocalInferenceAttemptRequestSchema.parse({ ...call, personalAuthority: authority(call.runId) }),
      origin: 'http://127.0.0.1:11434', signal: new AbortController().signal, think: false }
  }
  const turn = async (name?: string, bindingId?: string) => {
    const events = []
    for await (const event of backend.stream(await input(name, bindingId))) events.push(event)
    return events
  }
  return { backend, turn, acquisitions, posted, get listed() { return listed },
    advance: (ms: number) => { clock += ms }, offer: (next: string[]) => { slugs = next },
    failList: (fails: boolean) => { listFails = fails }, failPost: (status: number) => { postStatus = status } }
}

test('one turn reads the provider model list once, however often the host looks', async () => {
  const f = fixture()
  // The host looks before the request, the backend at it, and the host again after it.
  await f.backend.observe()
  await f.turn()
  await f.backend.observe()
  assert.equal(f.listed, 1)
  assert.deepEqual(f.acquisitions, ['discovery', 'inference'], 'no credential is leased just to look again')
  // A second turn inside the window costs no list read at all.
  await f.turn()
  assert.equal(f.listed, 1)
  assert.equal(f.posted.length, 2)
})

test('every model the plan lists is offered, each with the capacity the provider states', async () => {
  const f = fixture()
  const models = await f.backend.observe()
  assert.deepEqual(models.map((model) => model.providerModelId), ['gpt-6.1-sol', 'gpt-6.1-luna'])
  assert.deepEqual(models.map((model) => model.numCtxCap), [400_000, 400_000])
  await f.turn('gpt-6.1-luna')
  assert.equal(f.posted[0]?.model, 'gpt-6.1-luna')
})

test('the saved list runs out after its window and the next look asks again', async () => {
  const f = fixture()
  await f.backend.observe()
  f.offer(['gpt-6.1-sol'])
  f.advance(CHATGPT_INVENTORY_TTL_MS - 1)
  assert.equal((await f.backend.observe()).length, 2)
  f.advance(1)
  assert.deepEqual((await f.backend.observe()).map((model) => model.providerModelId), ['gpt-6.1-sol'])
  assert.equal(f.listed, 2)
})

test('a failed request drops the saved list, so a withdrawn model is refused on the next turn', async () => {
  const f = fixture()
  await f.turn('gpt-6.1-luna')
  f.offer(['gpt-6.1-sol'])
  f.failPost(500)
  await assert.rejects(f.turn('gpt-6.1-luna'))
  assert.equal(f.listed, 1, 'the failed turn itself still used the saved list')
  f.failPost(200)
  assert.deepEqual((await f.backend.observe()).map((model) => model.providerModelId), ['gpt-6.1-sol'])
  assert.equal(f.listed, 2)
})

test('a list that cannot be read is never replaced by an older one', async () => {
  const f = fixture()
  await f.backend.observe()
  f.advance(CHATGPT_INVENTORY_TTL_MS)
  f.failList(true)
  assert.deepEqual(await f.backend.observe(), [])
  f.failList(false)
  assert.equal((await f.backend.observe()).length, 2)
})

test('a zero window keeps the old behaviour: every look asks the provider', async () => {
  const f = fixture({ inventoryTtlMs: 0 })
  await f.backend.observe()
  await f.backend.observe()
  assert.equal(f.listed, 2)
})

test('personal requests carry one stable prompt cache key per agent', async () => {
  const f = fixture()
  const first = '11111111-1111-4111-8111-111111111111'
  const second = '22222222-2222-4222-8222-222222222222'
  await f.turn('gpt-6.1-sol', first)
  await f.turn('gpt-6.1-sol', first)
  await f.turn('gpt-6.1-sol', second)
  const keys = f.posted.map((body) => body.prompt_cache_key)
  assert.match(String(keys[0]), /^[a-f0-9]{32}$/)
  assert.equal(keys[0], keys[1])
  assert.notEqual(keys[0], keys[2])
  assert.equal(String(keys[0]).includes(first), false, 'the key names nothing')
  assert.equal(keys[0], chatgptPromptCacheKey({ bindingId: first } as never))
})

const context = (expiresInMs: number, now: number, epoch = '7'): ExecutorChatgptContext => ({
  connectionEpoch: epoch, expiresAt: new Date(now + expiresInMs).toISOString() } as ExecutorChatgptContext)

test('leases reuse the host’s last authority check; the timer always asks', async () => {
  let clock = 5_000_000
  let asked = 0
  const shared = shareChatgptAuthority(async () => { asked++; return context(900_000, clock) }, { now: () => clock })
  await shared.fresh()
  // A turn takes three leases. None of them asks again.
  await shared.recent(); await shared.recent(); await shared.recent()
  assert.equal(asked, 1)
  clock += CHATGPT_AUTHORITY_MAX_AGE_MS - 1
  await shared.recent()
  assert.equal(asked, 1)
  clock += 1
  await shared.recent()
  assert.equal(asked, 2, 'an answer older than the window is asked for again')
  await shared.fresh()
  assert.equal(asked, 3, 'the five-second check never reuses an answer')
})

test('callers that arrive during one check share it', async () => {
  let asked = 0
  let answer!: (value: ExecutorChatgptContext) => void
  const shared = shareChatgptAuthority(() => {
    asked++
    return new Promise<ExecutorChatgptContext>((resolve) => { answer = resolve })
  })
  const waiting = [shared.recent(), shared.fresh(), shared.recent()]
  answer(context(900_000, Date.now()))
  const answers = await Promise.all(waiting)
  assert.equal(asked, 1)
  assert.equal(new Set(answers).size, 1)
})

test('a failed or expired check is never leased from', async () => {
  let clock = 9_000_000
  let fail = false
  let asked = 0
  const shared = shareChatgptAuthority(async () => {
    asked++
    if (fail) throw new Error('chatgpt_owner_authority_unavailable')
    return context(3_000, clock)
  }, { now: () => clock })
  await shared.fresh()
  clock += 3_000
  await shared.recent()
  assert.equal(asked, 2, 'an answer past its own expiry is not reused, whatever its age')
  fail = true
  await assert.rejects(shared.fresh())
  // The last good answer is forgotten: the next lease must ask, and is refused.
  await assert.rejects(shared.recent())
  assert.equal(asked, 4)
  fail = false
  await shared.recent()
  assert.equal(asked, 5)
})
