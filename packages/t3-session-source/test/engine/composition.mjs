import assert from 'node:assert/strict'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import { Config, Settings, ProviderHost, ProviderCredentialReferences, ProviderCredentialReferenceError,
  SessionBackground, sessionProviderHostLayer, SessionRuntimeRequests, RuntimeRequests, ProviderSessions,
  ProjectionStore, sessionResourceCleanupLayer, ResourceOwners, SessionResourceTargets,
} from '@nessie/t3-session-source/engine'

// Unit composition over the normal generated source. These service doubles do
// not establish native admission, provider execution or positive lifetime proof.
const settings = { synthetic: 'settings' }
const unavailable = new ProviderCredentialReferenceError({ reason: 'unavailable' })
const resolved = []
const host = sessionProviderHostLayer.pipe(Layer.provide(Layer.mergeAll(
  Layer.succeed(Config.ServerConfig, { cwd: '/synthetic/project', baseDir: '/synthetic',
    stateDir: '/synthetic/state', providerStatusCacheDir: '/synthetic/cache', attachmentsDir: '/synthetic/attachments' }),
  Layer.succeed(Settings.ServerSettingsService, { getSettings: Effect.succeed(settings),
    withSettingsSnapshot: use => use(settings), streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty) }),
  Layer.succeed(SessionBackground.BackgroundPolicy, { shouldRunScopeWork: () => Effect.succeed(false) }),
  Layer.succeed(ProviderCredentialReferences, { resolve: (namespace, bindingId) => Effect.suspend(() => {
    resolved.push([namespace, bindingId])
    return bindingId === 'missing' ? Effect.fail(unavailable)
      : Effect.succeed({ binding: { owner: 'provider', key: 'synthetic:opaque-native-reference' } })
  }) }),
  Layer.succeed(FileSystem.FileSystem, { exists: () => Effect.succeed(false) }),
)))
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const service = yield* ProviderHost.ProviderHost
  assert.equal('credentials' in service, false)
  assert.equal(yield* service.settings.withSnapshot(value => Effect.succeed(value)), settings)
  assert.equal(yield* service.shouldRunBackgroundWork({ type: 'thread', threadId: 'synthetic' }), false)
  assert.equal(yield* service.resolveExtractedTextPath('/synthetic/file.docx'), undefined)
  const reference = yield* service.credentialReference('codex', 'bound')
  assert.deepEqual(Object.keys(reference), ['binding'])
  assert.deepEqual(Object.keys(reference.binding), ['owner', 'key'])
  const refused = yield* Effect.exit(service.credentialReference('claude', 'missing'))
  assert.equal(Exit.isFailure(refused), true)
}).pipe(Effect.provide(host))))
assert.deepEqual(resolved, [['codex', 'bound'], ['claude', 'missing']])

let request
let sends = 0
const requestLayer = SessionRuntimeRequests.layer.pipe(Layer.provide(Layer.mergeAll(
  Layer.succeed(ProjectionStore.ProjectionStoreV2, { getRuntimeRequest: () => Effect.succeed(request) }),
  Layer.succeed(ProviderSessions.ProviderSessionManagerV2, {
    get: () => Effect.succeed(Option.some({ respondToRuntimeRequest: () => Effect.sync(() => { sends++ }) })),
  }),
)))
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const service = yield* RuntimeRequests.RuntimeRequestServiceV2
  const input = { threadId: 'synthetic:thread', providerSessionId: 'synthetic:provider', requestId: 'synthetic:request' }
  for (const value of [undefined, { status: 'pending' },
    { status: 'resolved', responseCapability: { type: 'live', providerSessionId: 'another-provider' } }]) {
    request = value
    assert.equal(Exit.isFailure(yield* Effect.exit(service.respond(input))), true)
  }
  assert.equal(sends, 0)
  request = { status: 'resolved', responseCapability: { type: 'live', providerSessionId: input.providerSessionId } }
  yield* service.respond(input)
  assert.equal(sends, 1)
}).pipe(Effect.provide(requestLayer))))

const cleanupCalls = []
const cleanup = sessionResourceCleanupLayer.pipe(Layer.provide(Layer.mergeAll(
  Layer.succeed(Config.ServerConfig, { attachmentsDir: '/synthetic/attachments' }),
  Layer.succeed(FileSystem.FileSystem, { remove: path => Effect.sync(() => { cleanupCalls.push(['file', path]) }) }),
  Layer.succeed(SessionResourceTargets, {
    terminals: { close: input => Effect.sync(() => { cleanupCalls.push(['terminal', input]) }) },
    previews: { close: () => Effect.fail('synthetic:clearance-refused') },
    scheduledTasks: { deleteForThread: id => Effect.sync(() => { cleanupCalls.push(['schedule', id]) }) },
  }),
)))
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const service = yield* ResourceOwners.ResourceCleanupService
  yield* service.cleanupScheduledTasks('synthetic:thread')
  yield* service.cleanupTerminals('synthetic:thread')
  assert.equal(Exit.isFailure(yield* Effect.exit(service.cleanupPreviews('synthetic:thread'))), true)
  yield* service.cleanupAttachments(['../../outside'])
  assert.deepEqual(cleanupCalls, [
    ['schedule', 'synthetic:thread'], ['terminal', { threadId: 'synthetic:thread', deleteHistory: true }],
  ])
}).pipe(Effect.provide(cleanup))))
console.log(JSON.stringify({ originalRequestRefusals: 3, resourceFailureRetained: true, opaqueHostReferences: true }))
