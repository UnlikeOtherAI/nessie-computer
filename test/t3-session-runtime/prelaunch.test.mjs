import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { Launch, Projects, ProjectStore, CommandReceipts, IdAllocator, Threads,
  Settings, ProjectClones, ProviderCatalog, TextGeneration, Terminals, Workspace,
} from '@nessie/t3-session-source/engine'

// Exercises the original extracted launch constructor against refusal traps.
// These doubles prove no authority, SQL recovery or native/provider readiness.
const fixture = () => {
  let allocations = 0
  const forbidden = () => Effect.die('inspection reached a mutating or probing service')
  const layer = Launch.layer.pipe(Layer.provide(Layer.mergeAll(
    Layer.mock(Projects.ProjectService)({ getById: forbidden }),
    Layer.mock(ProjectStore.ProjectStoreV2)({ getShell: () => Effect.succeed(Option.some({
      id: 'project:inspect', workspaceRoot: 'C:/held/project', scripts: [],
    })) }),
    Layer.mock(Workspace.Setup.WorktreeSetupTracker)({}),
    Layer.mock(ProjectClones.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(Terminals.TerminalManager)({}),
    Layer.mock(Workspace.Git.GitWorkflowService)({}),
    Layer.mock(Workspace.SetupScripts.ProjectSetupScriptRunner)({}),
    Layer.mock(ProviderCatalog.ProviderRegistry)({}),
    Layer.mock(Settings.ServerSettingsService)({}),
    Layer.mock(TextGeneration.TextGeneration)({}),
    Layer.mock(CommandReceipts.CommandReceiptStoreV2)({ getByCommandId: () => Effect.succeed(Option.none()) }),
    Layer.mock(IdAllocator.IdAllocatorV2)({ allocate: { thread: () => Effect.sync(() => `thread:${++allocations}`) } }),
    Layer.mock(Threads.ThreadManagementService)({ assertProviderInstanceEnabled: () => Effect.void,
      getThreadRecords: forbidden, getMessageCount: forbidden }),
    Layer.mock(Workspace.ManagedProjects.ManagedProjectFolders)({ isScratchProject: forbidden,
      folderForThread: forbidden }),
  )))
  const input = { commandId: 'command:inspect', projectId: 'project:inspect', title: 'Inspection',
    modelSelection: { instanceId: 'codex', model: 'model' }, workspaceStrategy: { type: 'worktree' },
    createdBy: 'user', creationSource: 'mcp', runtimeMode: 'full-access', interactionMode: 'default' }
  return { layer, input, allocations: () => allocations }
}

test('original selection neither probes Scratch nor enriches projects and retires on scope exit', async () => {
  const { layer, input, allocations } = fixture()
  let escaped
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const launches = yield* Launch.ThreadLaunchService
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
    const launches = yield* Launch.ThreadLaunchService
    return yield* launches.prepareTarget({ ...input, threadId: 'thread:existing', reuseExistingThread: true })
  }).pipe(Effect.provide(layer)))))
})
