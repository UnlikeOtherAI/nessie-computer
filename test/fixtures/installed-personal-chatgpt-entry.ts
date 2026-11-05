/** Candidate-only entry. Never imported by the production CLI or selected by env/stdin. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'
import { z } from 'zod'
import type { PinnedFetch } from '@nessie/executor-support/url-safety'
import { runChatgptCredentialRuntime } from '../../src/chatgpt-credential-runtime.js'
import { CHATGPT_ISSUER, CHATGPT_RESOURCE, ChatgptOAuthProvider } from '../../src/chatgpt-oauth-provider.js'
import { CHATGPT_MODELS_URL, CHATGPT_RESPONSES_URL, type ChatgptFetch } from '../../src/chatgpt-http.js'
import { ChatgptProfileStore, chatgptBytesDigest } from '../../src/chatgpt-profile-store.js'
import { assertOwnerOnlyStatePath, secureOwnerOnlyStateFile } from '../../src/state-security.js'
import { loadExecutorState } from '../../src/state-store.js'
import { createPersonalStateMutation } from '../../src/personal-state-mutation.js'

const CLIENT = 'oaiapp_installed_fixture_nessie'
const SUBJECT = 'installed-fixture-openai-subject'
const ACCESS = 'installed-fixture-access'
const REFRESH = 'installed-fixture-refresh'

const callback = (url: URL): Promise<number> => new Promise((resolve, reject) => {
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.pathname, '/auth/callback')
  assert.ok(url.port)
  const outgoing = request(url, { timeout: 5000 }, response => {
    response.resume()
    response.once('end', () => resolve(response.statusCode!))
  })
  outgoing.once('error', reject)
  outgoing.once('timeout', () => outgoing.destroy(new Error('fixture_callback_timeout')))
  outgoing.end()
})

const actor = async (args: string[]): Promise<void> => {
  const paired = await loadExecutorState(args[2]!)
  const origin = new URL(paired.apiBaseUrl)
  assert.equal(origin.protocol, 'http:')
  assert.equal(origin.hostname, '127.0.0.1')
  const directory = new ChatgptProfileStore().profileDirectory(args[4]!)
  const events = join(directory, 'installed-fixture-events.log')
  // This file has public operation names only: no URL, OAuth parameter,
  // profile/principal, token, prompt, response or key is recorded.
  const trace = async (event: 'exchange' | 'jwks' | 'refresh' | 'revoke' | 'models' | 'post'): Promise<void> => {
    await appendFile(events, `${event}\n`, { mode: 0o600 })
    await secureOwnerOnlyStateFile(events)
  }
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  let authorization: URL | undefined
  let codeUsed = false
  let refreshes = 0
  const transport: PinnedFetch = async (url, init = {}) => {
    assert.equal(url.origin, CHATGPT_ISSUER)
    assert.equal(init.redirect, 'error')
    if (url.pathname.endsWith('openid-configuration')) return Response.json({ issuer: CHATGPT_ISSUER,
      authorization_endpoint: `${CHATGPT_ISSUER}/api/accounts/authorize`,
      token_endpoint: `${CHATGPT_ISSUER}/api/accounts/oauth/token`,
      jwks_uri: `${CHATGPT_ISSUER}/.well-known/jwks.json`,
      revocation_endpoint: `${CHATGPT_ISSUER}/revoke` })
    if (url.pathname.endsWith('jwks.json')) {
      await trace('jwks')
      return Response.json({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }),
        alg: 'RS256', use: 'sig', kid: 'installed-fixture-key' }] })
    }
    const body = init.body
    assert.ok(body instanceof URLSearchParams)
    assert.equal(body.get('client_id'), CLIENT)
    if (url.pathname.endsWith('/revoke')) {
      assert.ok(body.get('token')?.startsWith(REFRESH))
      await trace('revoke')
      return new Response(null, { status: 200 })
    }
    assert.equal(url.pathname, '/api/accounts/oauth/token')
    assert.equal(body.get('resource'), CHATGPT_RESOURCE)
    if (body.get('grant_type') === 'refresh_token') {
      assert.ok(body.get('refresh_token')?.startsWith(REFRESH))
      await trace('refresh')
      return Response.json({ access_token: ACCESS, refresh_token: `${REFRESH}-${++refreshes}`,
        token_type: 'Bearer', expires_in: 3600 })
    }
    assert.equal(body.get('grant_type'), 'authorization_code')
    assert.ok(authorization)
    assert.equal(codeUsed, false)
    codeUsed = true
    assert.equal(body.get('code'), 'installed-fixture-code')
    assert.equal(body.get('redirect_uri'), authorization.searchParams.get('redirect_uri'))
    assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'),
      authorization.searchParams.get('code_challenge'))
    const now = Math.floor(Date.now() / 1000)
    const idToken = await new SignJWT({ nonce: authorization.searchParams.get('nonce') })
      .setProtectedHeader({ alg: 'RS256', kid: 'installed-fixture-key' }).setIssuer(CHATGPT_ISSUER)
      .setAudience(CLIENT).setSubject(SUBJECT).setIssuedAt(now).setExpirationTime(now + 3600).sign(pair.privateKey)
    await trace('exchange')
    return Response.json({ id_token: idToken, access_token: ACCESS, refresh_token: REFRESH,
      // Real rotation/CAS is required by the first discovery lease, with no
      // sleep or credential editing. The ID token remains normally valid.
      token_type: 'Bearer', expires_in: 1,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' })
  }
  const browser = async (value: string): Promise<void> => {
    authorization = new URL(value)
    assert.equal(authorization.origin, CHATGPT_ISSUER)
    assert.equal(authorization.pathname, '/api/accounts/authorize')
    assert.equal(authorization.searchParams.get('resource'), CHATGPT_RESOURCE)
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
    const client = authorization.searchParams.get('client_id')
    assert.ok(client === 'dynamic_agent_client' || client === CLIENT)
    assert.equal(authorization.searchParams.get('agent_name_hint'), client === CLIENT ? null : 'Nessie')
    assert.equal(new Set(['state', 'nonce', 'code_challenge'].map(key =>
      authorization!.searchParams.get(key))).size, 3)
    const redirect = new URL(authorization.searchParams.get('redirect_uri')!)
    redirect.searchParams.set('state', 'incorrect-installed-fixture-state')
    redirect.searchParams.set('client_id', CLIENT)
    redirect.searchParams.set('code', 'installed-fixture-code')
    assert.equal(await callback(redirect), 400)
    assert.equal(codeUsed, false)
    redirect.searchParams.set('state', authorization.searchParams.get('state')!)
    assert.equal(await callback(redirect), 200)
    assert.equal(codeUsed, true)
  }
  const fetchImpl: ChatgptFetch = async (url, init) => {
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${ACCESS}`)
    init.signal?.throwIfAborted()
    if (url === CHATGPT_MODELS_URL) {
      await trace('models')
      return Response.json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list', display_name: 'GPT-6.1 Sol' }] })
    }
    assert.equal(url, CHATGPT_RESPONSES_URL)
    assert.equal(init.method, 'POST')
    const body: unknown = JSON.parse(String(init.body))
    assert.ok(body && typeof body === 'object' && 'store' in body && 'stream' in body && 'model' in body)
    assert.equal(body.store, false)
    assert.equal(body.stream, true)
    assert.equal(body.model, 'gpt-6.1-sol')
    await trace('post')
    const faultPath = join(directory, 'installed-fixture-fault.json')
    const fault = await readFile(faultPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (fault) {
      await assertOwnerOnlyStatePath(faultPath, 'file')
      assert.ok(fault.length < 2048)
      z.object({ version: z.literal(1), operation: z.literal('crash_once_before_terminal') }).strict()
        .parse(JSON.parse(fault.toString('utf8')))
      const mutation = await createPersonalStateMutation()
      await mutation.mutate(faultPath, { operation: 'delete', expectedDigest: chatgptBytesDigest(fault) })
      await mutation.barrier(directory)
      // Actual kernel process death, after native invocation reservation and
      // mock POST but before output/usage publication. Restart must not replay.
      process.kill(process.pid, 'SIGKILL')
      await new Promise<never>(() => undefined)
    }
    // The closed installed journey scripts a main reply then its mandatory
    // completion review. Sequence is a wire fixture, never prompt matching.
    const posts = (await readFile(events, 'utf8')).split('\n').filter(event => event === 'post').length
    // Several foreground/background roots share this installed account. Each
    // root has one main reply and its completion review; sixteen is a hard
    // fixture wire ceiling, not a product retry or content-based dispatch.
    assert.ok(posts <= 16, 'Unexpected fixture provider POST')
    const answer = posts % 2 === 1 ? 'Installed fixture answer.'
      : JSON.stringify({ needsFollowUp: false, reason: 'The fixture request is complete.' })
    const messages = [{ type: 'response.output_text.delta', delta: answer },
      { type: 'response.completed', response: { id: 'installed-fixture-response', model: 'gpt-6.1-sol',
        status: 'completed', output: [{ id: 'installed-fixture-message', type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: answer }] }], usage: { input_tokens: 40, output_tokens: 7 } } }]
    return new Response(messages.map(message => `data: ${JSON.stringify(message)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } })
  }
  assert.equal(await runChatgptCredentialRuntime(args, { oauth: new ChatgptOAuthProvider(transport),
    browser, backendOptions: { fetchImpl } }), true)
}

const main = async (): Promise<void> => {
  // An installed candidate may run only in a deliberately separate OS account.
  // Do not replace an existing person's credentials with fixture material.
  assert.ok((process.getuid?.() ?? 0) > 0)
  assert.ok(userInfo().username.startsWith('nessie-chatgpt-fixture-'))
  const args = process.argv.slice(2)
  if (args[0] === 'installed-fixture-wire-status') {
    assert.equal(args.length, 3)
    assert.equal(args[1], '--profile-id')
    const profileId = z.string().uuid().parse(args[2])
    const file = join(new ChatgptProfileStore().profileDirectory(profileId), 'installed-fixture-events.log')
    await assertOwnerOnlyStatePath(file, 'file')
    const bytes = await readFile(file)
    assert.ok(bytes.length <= 1024 * 1024)
    assert.equal(bytes.at(-1), 10)
    const kinds = z.enum(['exchange', 'jwks', 'refresh', 'revoke', 'models', 'post'])
    const counts: Record<string, number> = {}
    for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
      const kind = kinds.parse(line)
      counts[kind] = (counts[kind] ?? 0) + 1
    }
    process.stdout.write(`${JSON.stringify({ version: 1, counts })}\n`)
  } else if (args[0] === 'personal-chatgpt-credential') await actor(args)
  else await import('../../src/index.js')
}
void main().catch(() => {
  process.stderr.write('installed_fixture_failed\n')
  process.exitCode = 1
})
