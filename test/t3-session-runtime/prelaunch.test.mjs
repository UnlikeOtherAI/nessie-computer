import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Ref from 'effect/Ref'
import { LaunchSelection, ProjectStore, ProjectionStore, CommandReceipts, IdAllocator,
  Settings, ProjectClones, SourceContracts, SessionControl, Launch,
  makeSessionEngineGraph, SessionEngineGraphClosed, CloneState,
} from '@nessie/t3-session-source/engine'

// Exercises the original extracted launch constructor against refusal traps.
// These doubles prove no authority, SQL recovery or native/provider readiness.
const fixture = () => {
  let allocations = 0
  const forbidden = () => Effect.die('inspection reached a mutating or probing service')
  const layer = LaunchSelection.layer.pipe(Layer.provide(Layer.mergeAll(
    Layer.mock(ProjectStore.ProjectStoreV2)({ getShell: () => Effect.succeed(Option.some({
      id: 'project:inspect', workspaceRoot: 'C:/held/project', scripts: [],
    })) }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThreadShell: forbidden }),
    Layer.mock(ProjectClones.ProjectCloneReadService)({ get: () => Effect.succeed(null) }),
    Layer.mock(Settings.ServerSettingsReadService)({ getSettings: Effect.succeed(
      Schema.decodeUnknownSync(SourceContracts.ServerSettings)({ providerInstances: { codex: { driver: 'codex' } } }),
    ) }),
    Layer.mock(CommandReceipts.CommandReceiptStoreV2)({ getByCommandId: () => Effect.succeed(Option.none()) }),
    Layer.mock(IdAllocator.IdAllocatorV2)({ allocate: { thread: () => Effect.sync(() => `thread:${++allocations}`) } }),
  )))
  const input = { commandId: 'command:inspect', projectId: 'project:inspect', title: 'Inspection',
    modelSelection: { instanceId: 'codex', model: 'model' }, workspaceStrategy: { type: 'worktree' },
    runtimeMode: 'full-access', interactionMode: 'default' }
  return { layer, input, allocations: () => allocations }
}

test('original selection neither probes Scratch nor enriches projects and retires on scope exit', async () => {
  const { layer, input, allocations } = fixture()
  let escaped
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const launches = yield* LaunchSelection.ThreadLaunchSelection
    const first = yield* launches.prepareTarget(input)
    const second = yield* launches.prepareTarget(input)
    assert.equal(first.threadId, second.threadId)
    assert.equal(allocations(), 1)
    yield* first.assertCurrent
    escaped = first
  }).pipe(Effect.provide(layer))))
  await assert.rejects(Effect.runPromise(escaped.assertCurrent))
})

test('inspection refuses transcript-dependent reuse instead of hydrating history', async () => {
  const { layer, input } = fixture()
  await assert.rejects(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const launches = yield* LaunchSelection.ThreadLaunchSelection
    return yield* launches.prepareTarget({ ...input, threadId: 'thread:existing', reuseExistingThread: true })
  }).pipe(Effect.provide(layer)))))
})

test('separate phase builds share the original selection when owned by one memo map', async () => {
  const { layer, input, allocations } = fixture()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const memo = yield* Layer.makeMemoMap
    const scope = yield* Effect.scope
    const cold = yield* Layer.buildWithMemoMap(layer, memo, scope)
    const first = yield* LaunchSelection.ThreadLaunchSelection.use(s => s.prepareTarget(input)).pipe(
      Effect.provide(cold))
    const admitted = yield* Layer.buildWithMemoMap(layer, memo, scope)
    const second = yield* LaunchSelection.ThreadLaunchSelection.use(s => s.prepareTarget(input)).pipe(
      Effect.provide(admitted))
    assert.equal(first.threadId, second.threadId)
    assert.equal(allocations(), 1)
  })))
})

test('closed graph cannot construct inspection or activate host services', async () => {
  const graph = await Effect.runPromise(Effect.scoped(makeSessionEngineGraph))
  for (const phase of [graph.inspection, graph.activate, graph.recovery, graph.continuationConsumer]) {
    await assert.rejects(Effect.runPromise(phase), SessionEngineGraphClosed)
  }
})

test('cold clone reader observes the same original map used by actual clone management', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { clones } = yield* CloneState.ProjectCloneState
    const read = yield* ProjectClones.ProjectCloneReadService
    assert.equal(yield* read.get('project:clone'), null)
    const snapshot = { projectId: 'project:clone', phase: 'running' }
    yield* Ref.update(clones, current => new Map(current).set('project:clone', { snapshot }))
    assert.equal(yield* read.get('project:clone'), snapshot)
    const refused = yield* Effect.exit(ProjectClones.rejectCommandsDuringClone(read,
      { type: 'thread.create', projectId: 'project:clone' }))
    assert.equal(refused._tag, 'Failure')
  }).pipe(Effect.provide(CloneState.readLayer))))
})

test('inspection invents no origin and admitted conversion keeps only authenticated provenance', async () => {
  const { layer, input, allocations } = fixture()
  const wire = { ...input, createdBy: 'system', creationSource: 'provider' }
  const pure = SessionControl.toLaunchTargetInput(wire)
  assert.deepEqual(Object.keys(pure).sort(), ['commandId', 'modelSelection', 'projectId'])
  const provenance = { createdBy: 'agent', creationSource: 'mcp' }
  const admitted = SessionControl.toAdmittedLaunchInput(wire, provenance)
  assert.equal(admitted.createdBy, 'agent')
  assert.equal(admitted.creationSource, 'mcp')
  assert.deepEqual(Launch.selectThreadLaunchTargetInput(admitted), pure)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const selection = yield* LaunchSelection.ThreadLaunchSelection
    const inspected = yield* selection.prepareTarget(pure)
    const actual = yield* selection.resolveTarget(admitted,
      { id: input.projectId, workspaceRoot: 'C:/held/project' })
    assert.equal(actual.candidateThreadId, inspected.threadId)
    assert.equal(actual.input.createdBy, 'agent')
    assert.equal(actual.input.creationSource, 'mcp')
    assert.equal(allocations(), 1)
  }).pipe(Effect.provide(layer))))
})
