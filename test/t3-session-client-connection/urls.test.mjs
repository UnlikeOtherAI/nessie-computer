import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { applySessionEngineBoundaryPatches } from '../../packaging/session-engine/patches.mjs'
import {
  applyClientConnectionPatches, applyWebConnectionPatches, clientConnectionManifestBytes,
  T3_CLIENT_CONNECTION_PATCHES, webConnectionManifestBytes,
} from '../../patches/t3-session/client-connection/index.mjs'
import { readOriginalSnapshot, readWebSnapshot, sha256, webTargetPath } from './source-fixture.mjs'
import { loadSharedBoundary, sourceFunctions } from './source-functions.mjs'

const original = await readOriginalSnapshot()
const snapshot = applyClientConnectionPatches(original)
const boundary = await loadSharedBoundary(snapshot)
const { normalizeHttpBaseUrl, deriveWsBaseUrl, httpBaseUrlFromWebSocket, environmentEndpointUrl,
  environmentWebSocketUrl, environmentResourceUrl } = boundary
const mount = '/t3/environments/key%2Fwith%25opaque/'
const base = `https://api.example${mount}`
const authPath = 'packages/client-runtime/src/authorization/remote.ts'
const assetsPath = 'packages/client-runtime/src/state/assets.ts'
const extractionManifest = JSON.parse(await readFile(
  new URL('../../packaging/session-engine/boundary-patches.json', import.meta.url), 'utf8',
))

test('the unchanged pinned shared helper reproduces the mounted-prefix loss', async () => {
  const baseline = await loadSharedBoundary(original)
  assert.equal(baseline.normalizeHttpBaseUrl(base), 'https://api.example/')
  assert.equal(normalizeHttpBaseUrl(base), base)
})

test('C02 applies immutable ordered full-file hashes and rejects wrong source, bytes, order and repeat', () => {
  assert.equal(snapshot.identity.commit, '25bf84ab07f53f141c20239c63e383823a9d5ea0')
  assert.equal(snapshot.identity.tree, 'b0ba4dad62fa11e0a1fd21f5d351d75926d7559e')
  assert.equal(snapshot.identity.archiveSha256, '6ec4dc60aa5b92dabbf69c55b408b1db87d77d0a132cbc1fbca61daa0b4f7096')
  assert.equal(snapshot.files.length, 2859)
  assert.equal(snapshot.identity.orderedPatchesSha256, T3_CLIENT_CONNECTION_PATCHES.capsuleManifestSha256)
  const manifest = JSON.parse(clientConnectionManifestBytes)
  assert.equal(sha256(clientConnectionManifestBytes), T3_CLIENT_CONNECTION_PATCHES.capsuleManifestSha256)
  assert.throws(() => applyClientConnectionPatches(snapshot), /SOURCE_MISMATCH/)
  assert.throws(() => applySessionEngineBoundaryPatches(original, Buffer.from(JSON.stringify({
    ...manifest, sourceCommit: '0'.repeat(40),
  }))), /MANIFEST_REFUSED/)
  assert.throws(() => applySessionEngineBoundaryPatches(original, Buffer.from(JSON.stringify({
    ...manifest, patches: [...manifest.patches].reverse(),
  }))), /SOURCE_MISMATCH/)
  assert.throws(() => applySessionEngineBoundaryPatches(original, Buffer.from(JSON.stringify({
    ...manifest, patches: [{ ...manifest.patches[0], to: `${manifest.patches[0].to}\n` }],
  }))), /RESULT_MISMATCH/)
  const modifiedFiles = [...new Set(manifest.patches.map(patch => patch.file))]
  for (const file of modifiedFiles) {
    const edits = manifest.patches.filter(patch => patch.file === file)
    assert.equal(sha256(original.read(file)), edits[0].beforeSha256)
    assert.equal(sha256(snapshot.read(file)), edits.at(-1).afterSha256)
    assert.equal(sha256(original.read(file)), edits[0].beforeSha256, 'original buffers remain immutable')
  }
  const combined = Buffer.from(JSON.stringify({
    ...manifest, patches: [...extractionManifest.patches, ...manifest.patches],
  }) + '\n')
  const composed = applySessionEngineBoundaryPatches(original, combined)
  assert.equal(composed.identity.orderedPatchesSha256, sha256(combined))
  for (const patch of extractionManifest.patches) {
    assert.equal(sha256(composed.read(patch.file)), patch.afterSha256, 'existing extraction seam remains applied')
  }
  for (const file of modifiedFiles) assert.deepEqual(composed.read(file), snapshot.read(file))
})

test('root and mounted normalization retain opaque bytes, clear base query/hash and are idempotent', () => {
  for (const [protocol, http, ws] of [
    ['http', 'http', 'ws'], ['https', 'https', 'wss'], ['ws', 'http', 'ws'], ['wss', 'https', 'wss'],
  ]) {
    for (const path of ['/', mount]) {
      const canonical = `${http}://api.example${path}`
      for (const ending of ['', '/', '///']) {
        const raw = `${protocol}://api.example${path.replace(/\/$/, '')}${ending}?ignore=1#token=secret`
        assert.equal(normalizeHttpBaseUrl(raw), canonical)
        assert.equal(normalizeHttpBaseUrl(normalizeHttpBaseUrl(raw)), canonical)
        assert.equal(deriveWsBaseUrl(raw), `${ws}://api.example${path}`)
        assert.equal(httpBaseUrlFromWebSocket(`${ws}://api.example${path}ws`), canonical)
      }
    }
  }
  assert.equal(normalizeHttpBaseUrl('HTTPS://EXAMPLE.com:443/a%2fb%25/'), 'https://example.com/a%2fb%25/')
  assert.equal(httpBaseUrlFromWebSocket('wss://ws/'), 'https://ws/')
  assert.equal(httpBaseUrlFromWebSocket('wss://api.example/t3/environments/ws/'), 'https://api.example/t3/environments/ws/')
  assert.equal(httpBaseUrlFromWebSocket('wss://api.example/ws/'), 'https://api.example/')
  const endpoint = boundary.createAdvertisedEndpoint({
    id: 'env', label: 'Fixture', provider: 'manual', httpBaseUrl: base,
    reachability: 'remote', source: 'manual',
  })
  assert.equal(endpoint.httpBaseUrl, base)
  assert.equal(endpoint.wsBaseUrl, base.replace('https:', 'wss:'))
})

test('every session endpoint resolves once under root and mounted environments', () => {
  const paths = [
    '/.well-known/t3/environment', '/oauth/token', '/api/auth/session',
    '/api/auth/websocket-ticket', '/api/auth/websocket-ticket/rpc', '/api/auth/websocket-ticket/media',
    '/api/orchestration/shell',
    '/api/orchestration/threads/mcp%3At%2F%C4%8D',
    '/api/orchestration/threads/mcp%3At%2F%C4%8D/bounded?compactIds=1&deferWork=1',
    '/api/orchestration/threads/mcp%3At%2F%C4%8D/history?cursor=opaque%2F%2B&view=work#row',
    '/api/orchestration/threads/mcp%3At%2F%C4%8D/transcript', '/ws',
    '/api/attachments/upload/token', '/api/assets/token/file%20name.pdf?cap=a%2Fb#page=2',
    '/api/preview-stream', '/api/device-stream',
  ]
  for (const origin of ['http://localhost:3773/', 'https://api.example/', base]) {
    for (const logical of paths) {
      const expected = origin + logical.slice(1)
      assert.equal(environmentEndpointUrl(origin, logical), expected)
      assert.equal(environmentEndpointUrl(origin, logical.slice(1)), expected)
      assert.equal(environmentEndpointUrl(origin, expected), expected)
      const mountedPath = expected.slice(new URL(origin).origin.length)
      assert.equal(environmentEndpointUrl(origin, mountedPath), expected)
    }
  }
  assert.equal(environmentEndpointUrl(base, '?x=2#row'), `${base}?x=2#row`)
  assert.equal(environmentEndpointUrl(base, mount.slice(0, -1)), base)
  assert.equal(environmentEndpointUrl(base, base.slice(0, -1)), base)
  assert.equal(environmentEndpointUrl(`${base}?old=1#old`, '/api/config'), `${base}api/config`)
  assert.equal(environmentEndpointUrl(base, '/api/assets/token/file name.pdf'), `${base}api/assets/token/file%20name.pdf`)
})

test('invalid schemes, credentials, traversal, ambiguous authority and cross-environment paths fail closed', () => {
  for (const input of [
    'file:///tmp/a', 'ftp://api.example/a', 'javascript:alert(1)', 'https:api.example',
    'https:///api.example', 'https://u:p@api.example/', ' https://api.example/',
    'https://api.example/../other', 'https://api.example/%2e%2e/other',
    'https://api.example/a/./b', 'https://api.example/a\\b', 'https://api.example/a%5cb',
    'https://api.example/a//b', 'https://api.example/a%zz/', 'https://api.example/a%0a/',
    'https://api.example/\nb',
  ]) assert.throws(() => normalizeHttpBaseUrl(input), undefined, input)
  for (const path of [
    '//evil.example/api/auth/session', '\\evil.example/api', '../api', '/api/%2e%2e/other',
    '/api/a//b', '/t3/environments/other/api/assets/token',
    `${mount}${mount.slice(1)}api/config`,
    'https://evil.example/api/auth/session', 'https://api.example/api/auth/session',
    'https://api.example/t3/environments/other/api/auth/session',
    'https://u:p@api.example/t3/environments/key%2Fwith%25opaque/api',
    'data:text/html,anything', '/api/%bad%/x',
  ]) assert.throws(() => environmentEndpointUrl(base, path), undefined, path)
})

test('actual auth and cookie-primary socket functions preserve mount, explicit paths and metadata', () => {
  const { rpcSocketUrl } = sourceFunctions(snapshot, authPath,
    'function rpcSocketUrl(', 'export const resolveRemoteWebSocketConnectionUrl', ['rpcSocketUrl'], boundary)
  const { appendClientConnectionParams } = sourceFunctions(snapshot, authPath,
    'export const appendClientConnectionParams =', 'export const exchangeRemoteDpopAccessToken',
    ['appendClientConnectionParams'])
  const { primarySocketUrl } = sourceFunctions(snapshot, 'packages/client-runtime/src/connection/resolver.ts',
    'function primarySocketUrl(', 'const makePrimaryBroker =', ['primarySocketUrl'],
    { environmentWebSocketUrl, appendClientConnectionParams })
  for (const httpBase of ['http://localhost:3773/', 'https://api.example/', base]) {
    const wsBase = deriveWsBaseUrl(httpBase)
    const expected = `${wsBase}ws`
    assert.equal(environmentWebSocketUrl(httpBase, wsBase), expected)
    assert.equal(environmentWebSocketUrl(httpBase, expected), expected)
    assert.equal(environmentWebSocketUrl(httpBase, `${wsBase}custom/socket?proxy=1#drop`), `${wsBase}custom/socket?proxy=1`)
    assert.equal(rpcSocketUrl(httpBase, wsBase).href, expected)
    const socket = new URL(primarySocketUrl({ httpBaseUrl: httpBase, wsBaseUrl: wsBase },
      { surface: 'web', deviceType: 'desktop' }, {}))
    assert.equal(socket.origin + socket.pathname, expected)
    assert.equal(socket.searchParams.get('connectionMethod'), 'direct')
    assert.equal(socket.searchParams.get('clientSurface'), 'web')
  }
  for (const ws of ['wss://evil.example/ws', 'wss://api.example/ws',
    'wss://api.example/t3/environments/other/ws', 'file:///ws']) {
    assert.throws(() => rpcSocketUrl(base, ws))
  }
})

test('actual asset resolver retains mount and signed query/hash, including deliberate absolute local-media resources', () => {
  const { resolveAssetUrl } = sourceFunctions(snapshot, assetsPath,
    'export function resolveAssetUrl(', 'export const EMPTY_ASSET_URL_ATOM', ['resolveAssetUrl'], boundary)
  for (const relative of ['/api/attachments/upload/token', '/api/assets/token/file%20name.png?cap=a%2Fb#image']) {
    assert.equal(resolveAssetUrl(base, relative), base + relative.slice(1))
    assert.equal(resolveAssetUrl(base, base + relative.slice(1)), base + relative.slice(1))
  }
  const local = 'http://127.0.0.1:3773/t3/environments/local/api/assets/local-token/image.png'
  assert.equal(resolveAssetUrl(base, local), local, 'existing explicit local-media fallback is retained without auth forwarding')
  for (const bad of ['//evil.example/upload', '../upload', '/t3/environments/other/api/assets/token',
    'file:///tmp/file', 'data:text/html,unsafe', 'https://user:password@evil.example/asset']) {
    assert.equal(resolveAssetUrl(base, bad), null)
  }
  assert.equal(environmentResourceUrl(base, '/api/assets/token'), `${base}api/assets/token`)
})

test('actual HTTP base helper retains the mount for all three Effect constructors', () => {
  const { remoteApiBaseUrl } = sourceFunctions(snapshot, 'packages/client-runtime/src/rpc/http.ts',
    'const remoteApiBaseUrl =', 'export const makeEnvironmentHttpApiClient', ['remoteApiBaseUrl'], boundary)
  assert.equal(remoteApiBaseUrl(base), base)
  assert.equal(remoteApiBaseUrl('wss://api.example/path?x=1'), 'https://api.example/path/')
})

test('separately committed web boundary resolves configured mounted HTTP requests', async () => {
  const manifest = JSON.parse(webConnectionManifestBytes)
  const webOriginal = await readWebSnapshot(manifest.patches[0].beforeSha256)
  const web = applyWebConnectionPatches(webOriginal)
  assert.equal(web.identity.orderedPatchesSha256, T3_CLIENT_CONNECTION_PATCHES.webManifestSha256)
  const { resolvePrimaryEnvironmentHttpUrl } = sourceFunctions(web, webTargetPath,
    'export function resolvePrimaryEnvironmentHttpUrl(', '/** Null only for desktop',
    ['resolvePrimaryEnvironmentHttpUrl'], {
      environmentEndpointUrl,
      readPrimaryEnvironmentTarget: () => ({ source: 'configured', target: { httpBaseUrl: base } }),
      resolveHttpRequestBaseUrl: target => target.target.httpBaseUrl,
    })
  assert.equal(resolvePrimaryEnvironmentHttpUrl('/api/config', { a: 'b/c' }), `${base}api/config?a=b%2Fc`)
  assert.equal(sha256(web.read(webTargetPath)), manifest.patches.at(-1).afterSha256)
})

test('patch family remains disjoint and JSON bytes are reproducible', async () => {
  const manifest = JSON.parse(clientConnectionManifestBytes)
  assert.deepEqual(Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), clientConnectionManifestBytes)
  assert.ok(manifest.patches.every(patch => typeof patch.semantics === 'string' && patch.semantics.length > 0))
  assert.ok(manifest.patches.every(patch => !/\/(threads|outbox|shell|queue)\./.test(patch.file)))
})
