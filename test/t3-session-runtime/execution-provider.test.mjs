import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { CodexSettings, ProviderDriverKind, ProviderInstanceConfig, ProviderInstanceId, ManagedPolicySummary }
  from '@nessie/t3-session-source/contracts'
import { SelectedProvider, SelectedCodex, SelectedClaude, Adapters, IdAllocator, ContinuationRequests,
  OriginalMcpProviderSessions, OriginalHostProcess, OriginalCodexFactory, OriginalClaudeRunner, Config, Settings,
  ProviderEvents, ThreadCommandExecutor, Workspace, Policy, sessionExecutionProvidersLayer, NativeChildProcesses }
  from '@nessie/t3-session-source/engine'
import { withOriginalState } from './outbox-fixture.mjs'
import { seedShutdownThread } from './shutdown-fixture.mjs'

const instanceId = ProviderInstanceId.make('selected-execution')
const entry = Schema.decodeUnknownSync(ProviderInstanceConfig)({ driver: 'codex',
  config: { homePath: 'C:\\held-home', binaryPath: 'C:\\codex.exe' } })
const forbidden = () => assert.fail('construction or metadata must not start a process')

test('selected Codex constructs the actual original adapter without product snapshot or text generation hosts', async () => {
  const driver = SelectedCodex.makeSelectedCodexExecutionDriver({ instanceId, compatibility: forbidden })
  let escaped
  const hosts = Layer.mergeAll(NodeCrypto.layerDigest, NodeFileSystem.layer, NodePath.layer,
    IdAllocator.layer, ContinuationRequests.layer, OriginalMcpProviderSessions.layer,
    Layer.succeed(OriginalCodexFactory.CodexAppServerClientFactory, { open: forbidden }),
    Layer.succeed(Config.ServerConfig, { attachmentsDir: 'C:\\synthetic-attachments' }),
    Layer.succeed(Settings.ServerSettingsService, {}))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const directory = yield* SelectedProvider.makeSelectedExecutionProvider({ driver, instanceId, entry,
      secrets: { environment: [], config: [] }, managedPolicy: undefined })
    escaped = directory
    const instance = yield* directory.getInstance(instanceId)
    assert.equal(instance.orchestrationAdapter.instanceId, instanceId)
    assert.equal(instance.driverKind, 'codex')
    assert.equal('snapshot' in instance, false)
    assert.equal('textGeneration' in instance, false)
    const registry = Adapters.fromProviderExecutionDirectory(directory)
    assert.equal(yield* registry.get(instanceId), instance.orchestrationAdapter)
    const metadata = yield* registry.getMetadata(instanceId)
    assert.equal(metadata.driver, 'codex')
    assert.equal(metadata.enabled, true)
    assert.equal(metadata.continuationKey, instance.continuationIdentity.continuationKey)
  }).pipe(Effect.provide(hosts), Effect.provideService(OriginalHostProcess.Environment, {}))))
  assert.deepEqual(await Effect.runPromise(escaped.listInstances), [])
  const registry = Adapters.fromProviderExecutionDirectory(escaped)
  const retired = await Effect.runPromise(registry.get(instanceId).pipe(Effect.result))
  assert.equal(retired._tag, 'Failure')
  assert.ok(retired.failure instanceof Adapters.ProviderAdapterRegistryLookupError)
})

test('execution projection retains original policy/codec/disable checks and closes its actual child scope', async () => {
  const calls = [], closed = []
  const instance = { instanceId, driverKind: 'codex', enabled: false,
    continuationIdentity: { driverKind: 'codex', continuationKey: 'actual-continuation' },
    orchestrationAdapter: { driver: 'codex', instanceId } }
  const driver = { driverKind: ProviderDriverKind.make('codex'), configSchema: CodexSettings,
    metadata: { displayName: 'Codex' }, defaultConfig: () => Schema.decodeSync(CodexSettings)({}),
    create: input => Effect.gen(function* () {
      calls.push(input)
      yield* Effect.addFinalizer(() => Effect.sync(() => closed.push(instanceId)))
      return instance
    }) }
  const managedPolicy = Schema.decodeUnknownSync(ManagedPolicySummary)({ organization: 'Protected Org',
    lockedSettings: [], limits: { providers: { allowedDrivers: ['claudeAgent'] } } })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const denied = yield* SelectedProvider.makeSelectedExecutionProvider({ driver, instanceId, entry,
      secrets: { environment: [], config: [] }, managedPolicy })
    assert.equal(yield* denied.getInstance(instanceId), undefined)
    assert.equal((yield* denied.listUnavailable).length, 1)
    assert.equal(calls.length, 0)
    const allowed = yield* SelectedProvider.makeSelectedExecutionProvider({ driver, instanceId,
      entry: { ...entry, enabled: false }, secrets: { environment: [], config: [] }, managedPolicy: undefined })
    assert.equal(yield* allowed.getInstance(instanceId), instance)
    assert.equal(calls[0].config.shadowHomePath, '')
    assert.equal(calls[0].enabled, false)
  })))
  assert.deepEqual(closed, [instanceId])
})

test('selected Claude constructs its original adapter without status probes or text generation', async () => {
  // Synthetic catalog data exercises construction only, never model admission.
  const scopedLimitNames = await Effect.runPromise(Ref.make({ overageIncluded: undefined }))
  const driver = SelectedClaude.makeSelectedClaudeExecutionDriver({ instanceId,
    modelCatalog: Effect.succeed({ models: [] }), scopedLimitNames })
  const entry = Schema.decodeUnknownSync(ProviderInstanceConfig)({ driver: 'claudeAgent',
    config: { homePath: 'C:\\synthetic-uncreated-claude-home', binaryPath: 'C:\\claude.exe' } })
  const hosts = Layer.mergeAll(NodeCrypto.layerSecureRandom, NodeFileSystem.layer, NodePath.layer,
    IdAllocator.layer, ContinuationRequests.layer, OriginalMcpProviderSessions.layer,
    Layer.succeed(OriginalClaudeRunner.ClaudeAgentSdkQueryRunner, { run: forbidden }),
    Layer.mock(NativeChildProcesses.ChildProcessSpawner)({ spawn: forbidden }),
    Layer.succeed(Config.ServerConfig, { attachmentsDir: 'C:\\synthetic-attachments' }),
    Layer.succeed(Settings.ServerSettingsService, {}))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const directory = yield* SelectedProvider.makeSelectedExecutionProvider({ driver, instanceId, entry,
      secrets: { environment: [], config: [] }, managedPolicy: undefined })
    const instance = yield* directory.getInstance(instanceId)
    assert.equal(instance.driverKind, 'claudeAgent')
    assert.equal('snapshot' in instance, false)
    assert.equal('textGeneration' in instance, false)
    const registry = Adapters.fromProviderExecutionDirectory(directory)
    assert.equal(yield* registry.get(instanceId), instance.orchestrationAdapter)
    const metadata = yield* registry.getMetadata(instanceId)
    assert.equal(metadata.driver, 'claudeAgent')
    assert.equal(metadata.enabled, true)
    assert.equal(metadata.continuationKey, instance.continuationIdentity.continuationKey)
  }).pipe(Effect.provide(hosts), Effect.provideService(OriginalHostProcess.Environment, {}))))
})

test('original adapter lookup preserves shared credential-change and access guards on execution projections', async () => {
  let opened = 0, access = 0, changing = true
  const adapter = { driver: 'codex', instanceId, openSession: () => Effect.sync(() => { opened++; return 'actual-session' }) }
  const auth = { credentialBinding: { owner: 'provider', key: 'actual-held-binding' },
    isChangingCredentials: Effect.sync(() => changing),
    withAccess: work => Effect.sync(() => { access++ }).pipe(Effect.andThen(work)) }
  const peer = { instanceId: ProviderInstanceId.make('peer-execution'), auth }
  const actual = { instanceId, auth, orchestrationAdapter: adapter }
  const registry = Adapters.fromProviderExecutionDirectory({
    getInstance: id => Effect.succeed(id === instanceId ? actual : undefined),
    listInstances: Effect.succeed([actual, peer]) })
  const selected = await Effect.runPromise(registry.get(instanceId))
  const denied = await Effect.runPromise(selected.openSession({ providerSessionId: 'allocated-session' }).pipe(Effect.result))
  assert.equal(denied._tag, 'Failure')
  assert.equal(opened, 0)
  changing = false
  assert.equal(await Effect.runPromise(selected.openSession({ providerSessionId: 'allocated-session' })), 'actual-session')
  assert.equal(opened, 1)
  assert.equal(access, 2, 'both matching credential owners must retain their original access wrappers')
})

test('original terminal-event ingestion persists usage-limit failures without constructing a diagnostic provider directory', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seedShutdownThread('usage-failure')
    const ports = Layer.mergeAll(IdAllocator.layer, ThreadCommandExecutor.layer,
      Layer.mock(Workspace.GitDriver.GitVcsDriver)({}))
    const built = yield* Layer.build(ProviderEvents.layer.pipe(Layer.provide(ports)))
    const ingestor = yield* ProviderEvents.ProviderEventIngestorV2.pipe(Effect.provide(built))
    const events = yield* ingestor.ingestNormalized({ threadId: 'usage-failure', runId: 'run:usage-failure',
      nodeId: 'node:usage-failure', providerSessionId: 'session:usage-failure', providerInstanceId: 'codex',
      commandId: 'original-terminal-command', event: { type: 'turn.terminal', driver: 'codex',
        providerThreadId: 'provider:usage-failure', providerTurnId: 'turn:usage-failure', runOrdinal: 1,
        status: 'failed', failureItemOrdinal: 1, threadDisposition: 'reusable',
        failure: { class: 'usage_limit', message: 'Synthetic provider limit', code: null, retryable: true } } })
    assert.equal(events.length, 1)
    assert.equal(events[0].event.type, 'turn-item.updated')
    assert.equal(events[0].event.payload.failure.class, 'usage_limit')
  }))
})

test('selected execution preserves the original managed ceiling before calling its required runtime policy', async () => {
  let calls = 0
  const expected = { runtimeMode: 'approval-required', interactionMode: 'default', cwd: 'C:\\held-workspace' }
  const base = { resolve: () => Effect.sync(() => { calls++; return expected }) }
  const adapter = { list: () => Effect.succeed([instanceId]), get: forbidden }
  const policy = Schema.decodeUnknownSync(ManagedPolicySummary)({ organization: 'Protected Org',
    lockedSettings: [], limits: { maxRuntimeMode: 'approval-required' } })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const context = yield* Layer.build(sessionExecutionProvidersLayer.pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(Adapters.ProviderAdapterRegistryV2, adapter),
      Layer.succeed(Policy.RuntimePolicyV2, base),
      Layer.succeed(Settings.ServerSettingsService, { managedPolicy: policy })))))
    const runtime = yield* Policy.RuntimePolicyV2.pipe(Effect.provide(context))
    const request = runtimeMode => ({ thread: { id: 'thread:ceiling', runtimeMode },
      modelSelection: { instanceId, model: 'synthetic-model' } })
    const denied = yield* runtime.resolve(request('full-access')).pipe(Effect.result)
    assert.equal(denied._tag, 'Failure')
    assert.ok(denied.failure instanceof Policy.RuntimePolicyAboveCeilingError)
    assert.equal(calls, 0)
    assert.equal(yield* runtime.resolve(request('approval-required')), expected)
    assert.equal(calls, 1)
    assert.equal(yield* Adapters.ProviderAdapterRegistryV2.pipe(Effect.provide(context)), adapter)
  })))
})
