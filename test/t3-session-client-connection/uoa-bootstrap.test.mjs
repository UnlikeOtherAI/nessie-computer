import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { UoaConnectionDenied } from '../../patches/t3-session/client-connection/uoa-account.ts'
import { applyClientConnectionPatches } from '../../patches/t3-session/client-connection/index.mjs'
import { readOriginalSnapshot } from './source-fixture.mjs'
import { sourceFunctions } from './source-functions.mjs'
import { createSourceModuleLoader } from './module-loader.mjs'

const dependencyDirectory = process.env.T3_CLIENT_CONNECTION_DEPENDENCY_DIRECTORY
if (!dependencyDirectory) throw new Error('Explicit owned Effect dependency directory required')
const snapshot = applyClientConnectionPatches(await readOriginalSnapshot())
const loader = createSourceModuleLoader(snapshot, { dependencyDirectory, stubs: {
  '@t3tools/shared/telemetryId': { hashTelemetryId: () => { throw new Error('UNEXPECTED_TELEMETRY') } },
} })
const Effect = await loader.external('effect/Effect')
const Result = await loader.external('effect/Result')
const http = await loader.load('packages/client-runtime/src/rpc/http.ts')
const auth = await loader.load('packages/client-runtime/src/authorization/remote.ts')
const descriptor = await loader.load('packages/client-runtime/src/environment/descriptor.ts')
const boundary = await loader.load('packages/shared/src/advertisedEndpoint.ts')
const catalog = await loader.load('packages/client-runtime/src/connection/catalog.ts')
const model = await loader.load('packages/client-runtime/src/connection/model.ts')
const compatibility = await loader.load('packages/client-runtime/src/connection/compatibility.ts')
const file = 'uoa-bootstrap.ts'
const bytes = readFileSync(new URL('../../patches/t3-session/client-connection/uoa-bootstrap.ts', import.meta.url))
const { authorizeUoaEnvironment } = sourceFunctions({ read: () => bytes }, file,
  'export const authorizeUoaEnvironment =', null, ['authorizeUoaEnvironment'], {
    Effect, UoaConnectionDenied, ...auth, ...descriptor, ...boundary, ...catalog, ...model, ...compatibility,
  })
const base = 'https://api.example/t3/environments/exact%25id/'
const row = { environmentId: 'exact-id', label: 'Offline computer',
  endpoint: { httpBaseUrl: base, wsBaseUrl: base.replace('https:', 'wss:') + 'ws' } }
const account = { subject: 'person', organizationId: 'org', teamId: 'team', sessionId: 'session', expiresAt: 200_000 }
const responseDescriptor = environmentId => Response.json({ environmentId, label: 'Descriptor',
  orchestrationProtocolVersion: 2, platform: { os: 'windows', arch: 'x64' },
  serverVersion: 'synthetic', capabilities: { repositoryIdentity: false } })
const fixture = ({ descriptorId = row.environmentId, connectResult, tokenType = 'Bearer' } = {}) => {
  const calls = [], connects = []
  const ports = { apiOrigin: 'https://api.example', now: () => 1_000,
    connect: async (...args) => { connects.push(args); return connectResult ?? {
      environmentId: row.environmentId, endpoint: row.endpoint, credential: 'one-use-synthetic',
      expiresAt: new Date(50_000).toISOString(),
    } },
  }
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (calls.length === 1) return responseDescriptor(descriptorId)
    if (calls.length !== 2) throw new Error('UNEXPECTED_FETCH')
    return Response.json({ access_token: 'scoped-synthetic', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: tokenType, expires_in: 60, scope: 'orchestration:read' })
  }
  return { calls, connects, ports,
    run: (environment = row, selected = account, signal = new AbortController().signal) => Effect.runPromise(
      authorizeUoaEnvironment(ports, selected, environment, signal).pipe(
        Effect.result, Effect.provide(http.layerRemoteHttpClient(fetch)),
      )),
  }
}

test('original descriptor/bootstrap codecs use the exact mounted URLs and preserve identity', async () => {
  const f = fixture()
  const result = await f.run()
  assert.equal(Result.isSuccess(result), true)
  assert.deepEqual(f.calls.map(call => call.url), [base + '.well-known/t3/environment', base + 'oauth/token'])
  assert.equal(f.connects.length, 1)
  assert.equal(result.success.registration.target.environmentId, row.environmentId)
  assert.equal(result.success.registration.profile.wsBaseUrl, row.endpoint.wsBaseUrl)
  assert.equal(result.success.registration.credential.token, 'scoped-synthetic')
  assert.equal(result.success.expiresAt, 61_000)
})

test('wrong descriptor fails before minting or exchanging bootstrap material', async () => {
  const f = fixture({ descriptorId: 'another-environment' })
  const result = await f.run()
  assert.equal(Result.isFailure(result), true)
  assert.equal(f.connects.length, 0)
  assert.equal(f.calls.length, 1)
})

test('changed connect destination is refused before credential exchange', async () => {
  const f = fixture({ connectResult: { environmentId: row.environmentId, credential: 'one-use-synthetic',
    endpoint: { httpBaseUrl: 'https://api.example/t3/environments/other/', wsBaseUrl: 'wss://api.example/t3/environments/other/ws' },
    expiresAt: new Date(50_000).toISOString() } })
  assert.equal(Result.isFailure(await f.run()), true)
  assert.equal(f.calls.length, 1)
})

test('foreign origin, expired account and cancellation make no requests', async () => {
  const foreign = fixture()
  assert.equal(Result.isFailure(await foreign.run({ ...row,
    endpoint: { httpBaseUrl: 'https://foreign.example/t3/environments/id/', wsBaseUrl: 'wss://foreign.example/t3/environments/id/ws' } })), true)
  assert.equal(foreign.calls.length, 0)
  const expired = fixture()
  assert.equal(Result.isFailure(await expired.run(row, { ...account, expiresAt: 999 })), true)
  assert.equal(expired.calls.length, 0)
  const cancelled = fixture(), controller = new AbortController()
  controller.abort()
  assert.equal(Result.isFailure(await cancelled.run(row, account, controller.signal)), true)
  assert.equal(cancelled.calls.length, 0)
})

test('DPoP access cannot be mislabeled as a bearer registration', async () => {
  const f = fixture({ tokenType: 'DPoP' })
  assert.equal(Result.isFailure(await f.run()), true)
})
