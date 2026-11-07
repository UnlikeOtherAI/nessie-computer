import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyClientConnectionPatches, applyWebConnectionPatches, webConnectionManifestBytes,
} from '../../patches/t3-session/client-connection/index.mjs'
import { readOriginalSnapshot, readWebSnapshot, webTargetPath } from './source-fixture.mjs'
import { createSourceModuleLoader } from './module-loader.mjs'
import { sourceFunctions } from './source-functions.mjs'

const dependencyDirectory = process.env.T3_CLIENT_CONNECTION_DEPENDENCY_DIRECTORY
if (!dependencyDirectory) throw new Error('Explicit owned T3_CLIENT_CONNECTION_DEPENDENCY_DIRECTORY is required')
const snapshot = applyClientConnectionPatches(await readOriginalSnapshot())
const loader = createSourceModuleLoader(snapshot, { dependencyDirectory })
const http = await loader.load('packages/client-runtime/src/rpc/http.ts')
const auth = await loader.load('packages/client-runtime/src/authorization/remote.ts')
const remote = await loader.load('packages/shared/src/remote.ts')
const descriptor = await loader.load('packages/client-runtime/src/environment/descriptor.ts')
const contracts = await loader.load('packages/contracts/src/index.ts')
const Effect = await loader.external('effect/Effect')
const Option = await loader.external('effect/Option')
const Result = await loader.external('effect/Result')
const Redacted = await loader.external('effect/Redacted')
const FetchHttpClient = await loader.external('effect/http/FetchHttpClient')
const mountedBase = 'https://api.example/t3/environments/key%2Fopaque%25/'
const bases = ['http://127.0.0.1:3773/', 'https://root.example/', mountedBase]
const ticket = () => Response.json({ ticket: 'synthetic-ticket', expiresAt: '2026-11-07T12:00:00Z' })
const token = type => Response.json({
  access_token: 'synthetic-access', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  token_type: type, expires_in: 3600, scope: 'orchestration:read',
})
const invalidAuth = () => Response.json({
  _tag: 'EnvironmentAuthInvalidError', code: 'auth_invalid', reason: 'invalid_credential', traceId: 'synthetic-trace',
}, { status: 401 })
const recorder = (...responses) => {
  const calls = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      const response = responses.shift()
      if (!response) throw new Error('UNEXPECTED_SYNTHETIC_FETCH')
      return response
    },
  }
}
const run = (effect, fixture) => Effect.runPromise(effect.pipe(Effect.provide(http.layerRemoteHttpClient(fixture.fetch))))

test('actual Effect URL builders and HTTP requests retain root/mounted paths and exact encoded params/query', async () => {
  for (const base of bases) {
    const urls = http.makeEnvironmentHttpApiUrlBuilder(base)
    const threadId = 'mcp:č/thread%id'
    const headers = { authorization: 'Bearer synthetic', 'x-t3-orchestration-protocol': '2' }
    const query = { compactIds: '1', deferWork: '1' }
    const requests = [
      ['shellSnapshot', { headers, query: {} }, 'api/orchestration/shell'],
      ['threadSnapshot', { headers, params: { threadId } }, `api/orchestration/threads/${encodeURIComponent(threadId)}`],
      ['threadBoundedSnapshot', { headers, params: { threadId }, query }, `api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`],
      ['threadHistoryPage', { headers, params: { threadId }, query: { cursor: 'opaque/+%', view: 'work' } },
        `api/orchestration/threads/${encodeURIComponent(threadId)}/history`],
      ['threadTranscript', { headers, params: { threadId } }, `api/orchestration/threads/${encodeURIComponent(threadId)}/transcript`],
    ]
    for (const [name, input, path] of requests) {
      const fixture = recorder(invalidAuth())
      const expected = urls.orchestration[name](input)
      assert.equal(new URL(expected).origin + new URL(expected).pathname, base + path)
      const result = await run(Effect.gen(function* () {
        const client = yield* http.makeEnvironmentHttpApiGroupClient(base, 'orchestration')
        return yield* client[name](input)
      }).pipe(Effect.result), fixture)
      assert.equal(Result.isFailure(result), true)
      assert.equal(result.failure._tag, 'EnvironmentAuthInvalidError')
      assert.equal(fixture.calls.length, 1)
      assert.equal(fixture.calls[0].url, expected, 'actual fetch URL equals the original schema URL builder')
      assert.equal(fixture.calls[0].init.headers['x-t3-orchestration-protocol'], '2')
    }
    // Exercise the full-client constructor as well as the group constructor.
    const fixture = recorder(ticket())
    await run(Effect.gen(function* () {
      const client = yield* http.makeEnvironmentHttpApiClient(base)
      return yield* client.auth.webSocketTicketFor({ headers: {}, params: { use: 'rpc' } })
    }), fixture)
    assert.equal(fixture.calls[0].url, `${base}api/auth/websocket-ticket/rpc`)
  }
})

test('actual pairing helpers retain applicable legacy regressions and mounted direct/hosted pairing', () => {
  for (const host of ['https://remote.example', '//remote.example', '///remote.example', '//https://remote.example']) {
    assert.deepEqual(remote.resolveRemotePairingTarget({ host, pairingCode: 'synthetic-code' }), {
      credential: 'synthetic-code', httpBaseUrl: 'https://remote.example/', wsBaseUrl: 'wss://remote.example/',
    })
  }
  assert.deepEqual(remote.resolveRemotePairingTarget({ host: 'https://pair', pairingCode: 'synthetic-code' }), {
    credential: 'synthetic-code', httpBaseUrl: 'https://pair/', wsBaseUrl: 'wss://pair/',
  })
  assert.deepEqual(remote.resolveRemotePairingTarget({ host: 'https://api.example/t3/environments/pair/', pairingCode: 'synthetic-code' }), {
    credential: 'synthetic-code', httpBaseUrl: 'https://api.example/t3/environments/pair/',
    wsBaseUrl: 'wss://api.example/t3/environments/pair/',
  })
  for (const base of bases) {
    const expected = { credential: 'synthetic-code', httpBaseUrl: base, wsBaseUrl: base.replace(/^http/, 'ws') }
    assert.deepEqual(remote.resolveRemotePairingTarget({ host: base, pairingCode: 'synthetic-code' }), expected)
    assert.deepEqual(remote.resolveRemotePairingTarget({ pairingUrl: `${base}pair#token=synthetic-code` }), expected)
    assert.deepEqual(remote.resolveRemotePairingTarget({ pairingUrl: `${base}pair?token=synthetic-code` }), expected)
    assert.deepEqual(remote.resolveRemotePairingTarget({
      pairingUrl: `https://app.example/pair?host=${encodeURIComponent(base)}#token=synthetic-code`,
    }), expected)
  }
  assert.throws(() => remote.resolveRemotePairingTarget({ pairingUrl: 'ftp://remote.example/pair#token=code' }),
    error => error._tag === 'RemotePairingUrlInvalidError' && error.protocol === 'ftp:')
  assert.throws(() => remote.resolveRemotePairingTarget({ host: 'https://u:p@remote.example/', pairingCode: 'code' }))
  assert.throws(() => remote.resolveRemotePairingTarget({}), error => error._tag === 'RemoteBackendUrlMissingError')
  assert.throws(() => remote.resolveRemotePairingTarget({ pairingUrl: 'https://remote.example/pair' }),
    error => error._tag === 'RemotePairingTokenMissingError')
})

test('actual bearer and DPoP token exchange use mounted public URLs and original form/body/errors', async () => {
  for (const base of bases) {
    for (const type of ['Bearer', 'DPoP']) {
      const fixture = recorder(token(type))
      const input = { httpBaseUrl: base, credential: 'synthetic-bootstrap', scopes: ['orchestration:read'] }
      await run(type === 'Bearer' ? auth.bootstrapRemoteBearerSession(input)
        : auth.exchangeRemoteDpopAccessToken({ ...input, dpopProof: 'synthetic-token-proof' }), fixture)
      assert.equal(fixture.calls[0].url, `${base}oauth/token`)
      assert.equal(fixture.calls[0].init.method, 'POST')
      const body = fixture.calls[0].init.body
      const fields = new URLSearchParams(typeof body === 'string' ? body : new TextDecoder().decode(body))
      assert.equal(fields.get('subject_token'), 'synthetic-bootstrap')
      assert.equal(fields.get('scope'), 'orchestration:read')
      assert.equal(fields.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange')
      if (type === 'DPoP') assert.equal(fixture.calls[0].init.headers.dpop, 'synthetic-token-proof')
    }
    const fixture = recorder(invalidAuth())
    const result = await run(auth.issueRemoteWebSocketTicket({ httpBaseUrl: base, bearerToken: 'synthetic-expired' })
      .pipe(Effect.result), fixture)
    assert.equal(result.failure.reason, 'invalid_credential')
    assert.equal(fixture.calls[0].url, `${base}api/auth/websocket-ticket`)
  }
})

test('actual socket DPoP proofs name public ticket and upgrade paths, including audience fallback', async () => {
  for (const base of bases) {
    for (const fallback of [false, true]) {
      const fixture = fallback ? recorder(new Response('', { status: 404 }), ticket()) : recorder(ticket())
      const proofs = []
      const wsBase = base.replace(/^http/, 'ws')
      const url = new URL(await run(auth.resolveRemoteDpopWebSocketConnectionUrl({
        httpBaseUrl: base, wsBaseUrl: `${wsBase}ws?proxy=keep`, accessToken: 'synthetic-access',
        createProof: input => { proofs.push(input); return Effect.succeed(`synthetic-proof-${proofs.length}`) },
      }), fixture))
      assert.deepEqual(proofs[0], { method: 'POST', url: `${base}api/auth/websocket-ticket/rpc`, accessToken: 'synthetic-access' })
      if (fallback) assert.deepEqual(proofs[1], {
        method: 'POST', url: `${base}api/auth/websocket-ticket`, accessToken: 'synthetic-access',
      })
      assert.deepEqual(proofs.at(-1), { method: 'GET', url: `${base}ws`, accessToken: 'synthetic-ticket' })
      assert.equal(url.origin + url.pathname, `${wsBase}ws`)
      assert.equal(url.searchParams.get('proxy'), 'keep')
      assert.equal(url.searchParams.get('wsTicket'), 'synthetic-ticket')
      assert.equal(fixture.calls[0].url, proofs[0].url)
      if (fallback) assert.equal(fixture.calls[1].url, proofs[1].url)
    }
    const fixture = recorder(ticket())
    const bearerSocket = new URL(await run(auth.resolveRemoteWebSocketConnectionUrl({
      httpBaseUrl: base, wsBaseUrl: base.replace(/^http/, 'ws'), bearerToken: 'synthetic-bearer',
    }), fixture))
    assert.equal(bearerSocket.pathname, new URL(`${base}ws`).pathname)
  }
  const fixture = recorder()
  let proofCount = 0
  const result = await run(auth.resolveRemoteDpopWebSocketConnectionUrl({
    httpBaseUrl: mountedBase, wsBaseUrl: 'wss://api.example/t3/environments/other/ws', accessToken: 'synthetic',
    createProof: () => { proofCount += 1; return Effect.succeed('never') },
  }).pipe(Effect.exit), fixture)
  assert.equal(result._tag, 'Failure')
  assert.equal(proofCount, 0)
  assert.equal(fixture.calls.length, 0)
})

test('descriptor and config/readiness socket negotiation retain their original public entry points', async () => {
  const source = {
    environmentId: 'synthetic-environment', label: 'Fixture',
    orchestrationProtocolVersion: 2, platform: { os: 'windows', arch: 'x64' },
    serverVersion: 'synthetic-source-fixture', capabilities: { repositoryIdentity: false },
  }
  const fixture = recorder(Response.json(source))
  const value = await run(descriptor.fetchRemoteEnvironmentDescriptor({ httpBaseUrl: mountedBase }), fixture)
  assert.equal(value.environmentId, source.environmentId)
  assert.equal(fixture.calls[0].url, `${mountedBase}.well-known/t3/environment`)
  const { appendOrchestrationProtocol } = sourceFunctions(snapshot, 'packages/client-runtime/src/connection/compatibility.ts',
    'export function appendOrchestrationProtocol(', null, ['appendOrchestrationProtocol'], contracts)
  const socket = new URL(appendOrchestrationProtocol(`${mountedBase.replace('https:', 'wss:')}ws?wsTicket=synthetic`))
  assert.equal(socket.pathname, `${new URL(mountedBase).pathname}ws`)
  assert.equal(socket.searchParams.get('orchestrationProtocol'), '2')
  assert.equal(socket.searchParams.get('wsTicket'), 'synthetic')
  assert.equal(contracts.WS_METHODS.serverGetConfig, 'server.getConfig')
  // Config subscription/initial readiness continue using this one RPC socket;
  // this URL check does not simulate or claim the real readiness lifecycle.
})

test('actual ordinary HTTP authorization signs the same public bounded-history URL sent by Effect', async () => {
  const prelude = sourceFunctions(snapshot, 'packages/client-runtime/src/state/environmentHttpAuth.ts',
    'const withEnvironmentRequestInit =', '/**\n * A DPoP request',
    ['withEnvironmentRequestInit', 'buildEnvironmentAuthHeaders'], { Effect, Option, FetchHttpClient, ...http })
  const file = 'packages/client-runtime/src/state/environmentHttpAuth.ts'
  const { executeEnvironmentRequest } = sourceFunctions(snapshot, file,
    'const executeEnvironmentRequest =', null, ['executeEnvironmentRequest'],
    { Effect, Option, Result, ...http, ...prelude })
  const proofs = []
  const fixture = recorder(invalidAuth(), invalidAuth())
  const prepared = {
    environmentId: 'synthetic-environment', httpBaseUrl: mountedBase,
    target: { _tag: 'BearerConnectionTarget' }, httpAuthorization: { _tag: 'Dpop', accessToken: 'old' },
  }
  const authorization = { _tag: 'Dpop', accessToken: 'synthetic-access' }
  const request = executeEnvironmentRequest({
    prepared, signer: Option.some({ createProof: input => { proofs.push(input); return Effect.succeed('synthetic-proof') } }),
    remoteAuthorization: Option.some({ authorizeDpopHttp: () => Effect.succeed({ httpBaseUrl: mountedBase, httpAuthorization: authorization }) }),
    method: 'GET', timeoutMs: 2000, group: 'orchestration',
    url: urls => urls.threadHistoryPage({ params: { threadId: 'mcp:č/a' }, query: { cursor: 'cursor/+%' } }),
    request: ({ client, headers }) => client.threadHistoryPage({
      headers: { ...headers, 'x-t3-orchestration-protocol': '2' },
      params: { threadId: 'mcp:č/a' }, query: { cursor: 'cursor/+%' },
    }),
  })
  await run(request.pipe(Effect.result), fixture)
  assert.equal(fixture.calls.length, 2, 'original typed-auth retry is retained')
  for (let i = 0; i < fixture.calls.length; i += 1) {
    assert.equal(proofs[i].url, fixture.calls[i].url)
    assert.ok(proofs[i].url.startsWith(mountedBase))
    assert.equal(fixture.calls[i].init.headers.dpop, 'synthetic-proof')
  }
})

test('actual preview/device and speech resource constructors retain the mount and original ticket audience', async () => {
  const boundary = await loader.load('packages/shared/src/advertisedEndpoint.ts')
  const { resolveDeviceHubAccess } = sourceFunctions(snapshot, 'packages/client-runtime/src/state/deviceHubAccess.ts',
    'export const resolveDeviceHubAccess =', null, ['resolveDeviceHubAccess'], { Effect, ...boundary })
  for (const base of bases) {
    const hub = await Effect.runPromise(resolveDeviceHubAccess({
      prepared: { httpBaseUrl: base, httpAuthorization: null }, hubBasePath: '/api/preview-stream',
    }))
    assert.equal(hub.httpBase, `${base}api/preview-stream`)
    assert.equal(hub.wsBase, `${base.replace(/^http/, 'ws')}api/preview-stream`)
    assert.equal(hub.credentials, true)
    const proofTargets = []
    const { getEnvironmentSpeechStreamUrl } = sourceFunctions(snapshot, 'packages/client-runtime/src/voice-input/environment.ts',
      'export const getEnvironmentSpeechStreamUrl =', 'export const getEnvironmentSpeechModels',
      ['getEnvironmentSpeechStreamUrl'], {
        Effect, Redacted, ...boundary, SPEECH_STREAM_PATH: contracts.SPEECH_STREAM_PATH,
        request: input => {
          proofTargets.push(input.path(http.makeEnvironmentHttpApiUrlBuilder(base).auth))
          return Effect.succeed({ ticket: Redacted.make('synthetic-media-ticket') })
        },
      })
    const socket = new URL(await Effect.runPromise(getEnvironmentSpeechStreamUrl({ httpBaseUrl: base })))
    assert.equal(socket.href, `${base.replace(/^http/, 'ws')}${contracts.SPEECH_STREAM_PATH.slice(1)}?wsTicket=synthetic-media-ticket`)
    assert.deepEqual(proofTargets, [`${base}api/auth/websocket-ticket/media`])
  }
})

test('full committed web target preserves configured paths and the existing loopback dev proxy', async () => {
  const manifest = JSON.parse(webConnectionManifestBytes)
  const web = applyWebConnectionPatches(await readWebSnapshot(manifest.patches[0].beforeSha256))
  const combined = { ...snapshot, files: [...snapshot.files, ...web.files],
    read: path => web.files.includes(path) ? web.read(path) : snapshot.read(path) }
  const previousWindow = globalThis.window
  globalThis.window = { location: { origin: 'http://localhost:5173', href: 'http://localhost:5173/' } }
  try {
    for (const [configured, websocket, expected, dev] of [
      [mountedBase, undefined, mountedBase, undefined],
      [undefined, mountedBase.replace('https:', 'wss:') + 'ws', mountedBase, undefined],
      [undefined, 'wss://root.example/ws', 'https://root.example/', undefined],
      [undefined, '/ws', 'http://localhost:5173/', undefined],
      ['http://127.0.0.1:3773/mounted/', undefined, 'http://localhost:5173/mounted/', 'http://localhost:5173'],
    ]) {
      const webLoader = createSourceModuleLoader(combined, {
        dependencyDirectory, env: { VITE_HTTP_URL: configured, VITE_WS_URL: websocket, VITE_DEV_SERVER_URL: dev },
        stubs: { '../../localEnvironment': { isLocalEnvironmentDisabled: () => false } },
      })
      const target = await webLoader.load(webTargetPath)
      assert.equal(target.resolvePrimaryEnvironmentHttpUrl('/api/auth/session', { x: 'a/b' }), `${expected}api/auth/session?x=a%2Fb`)
    }
  } finally { globalThis.window = previousWindow }
})
