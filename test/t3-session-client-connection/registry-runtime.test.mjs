import assert from 'node:assert/strict'
import test from 'node:test'
import { applyClientConnectionPatches, applyRegistryConnectionPatches } from '../../patches/t3-session/client-connection/index.mjs'
import { readOriginalSnapshot } from './source-fixture.mjs'
import { createSourceModuleLoader } from './module-loader.mjs'

// Scheduled fixture: actual pinned registry/supervisor, synthetic storage and transport.
// It does not run in the source/tiny lane and is not a gateway/mobile acceptance claim.
const dependencyDirectory = process.env.T3_CLIENT_CONNECTION_DEPENDENCY_DIRECTORY
if (!dependencyDirectory) throw new Error('Explicit owned Effect dependency directory required')
const snapshot = applyRegistryConnectionPatches(applyClientConnectionPatches(await readOriginalSnapshot()))
const loader = createSourceModuleLoader(snapshot, { dependencyDirectory, stubs: {
  '@t3tools/shared/telemetryId': { hashTelemetryId: () => { throw new Error('UNEXPECTED_TELEMETRY') } },
} })
const Effect = await loader.external('effect/Effect')
const Context = await loader.external('effect/Context')
const Option = await loader.external('effect/Option')
const Stream = await loader.external('effect/Stream')
const SubscriptionRef = await loader.external('effect/SubscriptionRef')
const Registry = await loader.load('packages/client-runtime/src/connection/registry.ts')
const Catalog = await loader.load('packages/client-runtime/src/connection/catalog.ts')
const Model = await loader.load('packages/client-runtime/src/connection/model.ts')
const Driver = await loader.load('packages/client-runtime/src/connection/driver.ts')
const Connectivity = await loader.load('packages/client-runtime/src/connection/connectivity.ts')
const Wakeups = await loader.load('packages/client-runtime/src/connection/wakeups.ts')
const Credentials = await loader.load('packages/client-runtime/src/connection/credentialStore.ts')
const Profiles = await loader.load('packages/client-runtime/src/connection/profileStore.ts')
const Permissions = await loader.load('packages/client-runtime/src/connection/pullRequestRoutingPermissions.ts')
const Persistence = await loader.load('packages/client-runtime/src/platform/persistence.ts')
const Capabilities = await loader.load('packages/client-runtime/src/platform/capabilities.ts')

const registration = (token = 'synthetic-token', id = 'original-id') => {
  const target = new Model.BearerConnectionTarget({ environmentId: id, label: id, connectionId: `uoa:${id}` })
  return new Catalog.BearerConnectionRegistration({ target,
    profile: new Catalog.BearerConnectionProfile({ ...target,
      httpBaseUrl: `https://api.example/t3/environments/${id}/`, wsBaseUrl: `wss://api.example/t3/environments/${id}/ws` }),
    credential: new Catalog.BearerConnectionCredential({ token }),
  })
}
const harness = Effect.gen(function* () {
  const credentials = new Map(), disabled = new Set(), failures = new Set(), attempts = new Map()
  let opened = 0, closed = 0
  const attempt = name => Effect.suspend(() => {
    attempts.set(name, (attempts.get(name) ?? 0) + 1)
    return failures.has(name) ? Effect.fail(new Model.ConnectionTransientError({
      reason: 'remote-unavailable', detail: 'Synthetic storage failure',
    })) : Effect.void
  })
  const network = yield* SubscriptionRef.make('online')
  const driver = { connect: entry => Effect.acquireRelease(Effect.gen(function* () {
    opened++
    const token = credentials.get(entry.target.connectionId)?.token
    return { prepared: { target: entry.target, environmentId: entry.target.environmentId, label: entry.target.label,
      httpBaseUrl: 'https://api.example/t3/environments/original-id/', socketUrl: 'wss://api.example/t3/environments/original-id/ws',
      httpAuthorization: { _tag: 'Bearer', token } },
    session: { client: {}, initialConfig: Effect.die('unused'), subscribeServerConfig: () => Stream.never,
      ready: Effect.void, probe: Effect.void, inboundFrames: Effect.succeed(0), closed: Effect.never } }
  }), () => Effect.sync(() => { closed++ })),
  preflight: () => Effect.succeed('unchecked'), checkHost: () => Effect.succeed('unchecked') }
  const context = Context.empty().pipe(
    Context.add(Persistence.ConnectionTargetStore, { list: Effect.succeed([]),
      listDisabled: Effect.sync(() => [...disabled]) }),
    Context.add(Persistence.ConnectionRegistrationStore, { register: () => Effect.die('unexpected persistent target'),
      setRoutes: () => Effect.die('unexpected learned route'), remove: () => attempt('target'),
      setEnabled: (id, enabled) => Effect.sync(() => { if (enabled) disabled.delete(id); else disabled.add(id) }) }),
    Context.add(Persistence.EnvironmentCacheStore, { clear: () => attempt('cache') }),
    Context.add(Persistence.EnvironmentOwnedDataCleanup, { clear: () => attempt('outbox').pipe(Effect.orDie) }),
    Context.add(Profiles.ConnectionProfileStore, { get: () => Effect.succeedNone }),
    Context.add(Credentials.ConnectionCredentialStore, {
      get: id => Effect.sync(() => Option.fromUndefinedOr(credentials.get(id))),
      put: (id, credential) => attempt('put').pipe(Effect.andThen(Effect.sync(() => credentials.set(id, credential)))),
      remove: id => attempt('credential').pipe(Effect.andThen(Effect.sync(() => credentials.delete(id)))),
    }),
    Context.add(Permissions.PullRequestRoutingPermissions, {
      get: () => Effect.succeed('off'), changes: Stream.never, set: () => Effect.void, forget: () => attempt('trust'),
    }),
    Context.add(Connectivity.Connectivity, { status: SubscriptionRef.get(network), changes: SubscriptionRef.changes(network) }),
    Context.add(Wakeups.ConnectionWakeups, { changes: Stream.never }),
    Context.add(Driver.ConnectionDriver, driver),
    Context.add(Capabilities.SshEnvironmentGateway, { disconnect: () => Effect.void }),
  )
  const registry = yield* Registry.make.pipe(Effect.provide(context))
  return { registry, network, credentials, disabled, failures, attempts, opened: () => opened, closed: () => closed }
})
const waitPhase = (registry, id, phase) => registry.stateChanges(id).pipe(
  Stream.filter(state => state.phase === phase), Stream.runHead, Effect.timeout('2 seconds'))
const run = body => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  yield* body(yield* harness)
})).pipe(Effect.timeout('10 seconds')))

test('actual registry withdraws every environment despite permission/credential/cache/outbox failures and retries', () => run(
  Effect.fn(function* (f) {
    yield* f.registry.reconcilePlatform([registration(), registration('second-token', 'second')])
    yield* waitPhase(f.registry, 'original-id', 'connected')
    yield* waitPhase(f.registry, 'second', 'connected')
    for (const name of ['trust', 'credential', 'cache', 'outbox']) f.failures.add(name)
    yield* f.registry.reconcilePlatform([])
    assert.equal((yield* SubscriptionRef.get(f.registry.entries)).size, 0)
    assert.equal(f.closed(), 2)
    for (const name of f.failures) assert.ok(f.attempts.get(name) >= 2)
    const denied = yield* Effect.flip(f.registry.state('original-id'))
    assert.equal(denied._tag, 'EnvironmentNotRegisteredError')
    // Reappearing rows cannot reactivate old credentials while cleanup is still failing.
    yield* f.registry.reconcilePlatform([registration('new-token')])
    assert.equal((yield* SubscriptionRef.get(f.registry.entries)).size, 0)
    f.failures.clear()
    yield* f.registry.reconcilePlatform([])
    assert.equal(f.credentials.size, 0)
    yield* f.registry.reconcilePlatform([registration('new-token')])
    yield* waitPhase(f.registry, 'original-id', 'connected')
    assert.equal(f.credentials.get('uoa:original-id').token, 'new-token')
  }),
))

test('actual registry fails closed when renewed credentials cannot be stored', () => run(Effect.fn(function* (f) {
  yield* f.registry.reconcilePlatform([registration()])
  yield* waitPhase(f.registry, 'original-id', 'connected')
  f.failures.add('put')
  yield* f.registry.reconcilePlatform([registration('renewed')])
  assert.equal((yield* SubscriptionRef.get(f.registry.entries)).size, 0)
  assert.equal(f.closed(), 1)
  f.failures.clear()
  yield* f.registry.reconcilePlatform([registration('renewed')])
  yield* waitPhase(f.registry, 'original-id', 'connected')
  assert.equal(f.credentials.get('uoa:original-id').token, 'renewed')
})))

test('original runtime resolves a cold identity, retains it offline, reconnects and preserves disabled intent', () => run(
  Effect.fn(function* (f) {
    const missing = yield* Effect.flip(f.registry.state('original-id'))
    assert.equal(missing._tag, 'EnvironmentNotRegisteredError')
    yield* f.registry.reconcilePlatform([registration()])
    yield* waitPhase(f.registry, 'original-id', 'connected')
    yield* SubscriptionRef.set(f.network, 'offline')
    yield* waitPhase(f.registry, 'original-id', 'offline')
    assert.equal((yield* SubscriptionRef.get(f.registry.entries)).has('original-id'), true)
    yield* SubscriptionRef.set(f.network, 'online')
    yield* waitPhase(f.registry, 'original-id', 'connected')
    yield* f.registry.setEnabled('original-id', false)
    yield* f.registry.reconcilePlatform([registration('renewed')])
    assert.equal((yield* SubscriptionRef.get(f.registry.entries)).get('original-id').enabled, false)
    assert.equal(f.disabled.has('original-id'), true)
    yield* f.registry.reconcilePlatform([])
    yield* f.registry.reconcilePlatform([registration('new-account')])
    assert.equal((yield* SubscriptionRef.get(f.registry.entries)).get('original-id').enabled, false)
  }),
))
