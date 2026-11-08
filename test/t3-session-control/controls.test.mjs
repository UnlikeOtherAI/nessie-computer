import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { SourceContracts as S, Threads, Launch, Orchestrator } from '@nessie/t3-session-source/engine'
import { ExecutorT3Request } from '@nessie/executor-protocol/t3-session'
import { executeSessionControl, validateControlRequest } from '../../dist/t3-session/control/operations.js'
import { waitForSessionWork } from '../../dist/t3-session/control/receipts.js'
import { sessionControlToolOperations } from '../../dist/t3-session/tools/control.js'

const provenance = { createdBy: 'user', creationSource: 'mobile' }
const threadId = 'mcp:thread/雪:𐀀'
const routing = { transportVersion: 1, protocolVersion: 2,
  sourceRevision: '25bf84ab07f53f141c20239c63e383823a9d5ea0',
  executorId: '11111111-1111-4111-8111-111111111111', environmentId: 'environment:雪',
  connectionEpoch: '9007199254740993', runtimeGeneration: 'synthetic:runtime',
  correlationId: 'synthetic:call', relayOrdinal: 0, kind: 'request' }
const request = input => Schema.decodeUnknownSync(ExecutorT3Request)({ ...routing,
  method: 'orchestration.dispatchCommand', commandId: input.commandId, input })
const base = { commandId: 'command:雪', threadId }

// Synthetic service endpoints observe the REAL extracted adapter and intake.
// These are not authority, provider, durable dispatch or native custody fixtures.
const withServices = (program, dispatch, retryPreparation = () => Effect.die('unexpected retry')) =>
  Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(
    Layer.mock(Threads.ThreadManagementService)({ dispatch }),
    Layer.mock(Launch.ThreadLaunchService)({ retryPreparation }),
  ))))
const result = { sequence: 73, replayed: false, storedEvents: [] }

test('original intake keeps separate message/command IDs, exact text and queue/fresh-context modes', async () => {
  const seen = []
  for (const [index, text] of ['oprav to pls, dík', '  誤字なおして\n', 'ship it??'].entries()) {
    const command = { ...base, commandId: `command:${index}`, messageId: `message:${index}`,
      type: 'message.dispatch', text, attachments: [], createdBy: 'agent', creationSource: 'mcp',
      freshContext: true, dispatchMode: { type: 'queue_after_active' } }
    assert.deepEqual(await withServices(executeSessionControl(request(command), provenance),
      input => { seen.push(input); return Effect.succeed(result) }), { sequence: 73 })
    assert.deepEqual(seen[index], { ...command, ...provenance })
  }
  assert.equal(seen.length, 3)
})

test('queue edits/reorder/steer, stop, sidechat and merge retain their original commands', async () => {
  const commands = [
    { ...base, type: 'queued-run.edit', runId: 'run:queued', text: 'edit exact\n' },
    { ...base, type: 'queued-run.reorder', runId: 'run:queued', beforeRunId: 'run:first' },
    { ...base, type: 'queued-message.promote-to-steer', queuedRunId: 'run:queued', targetRunId: 'run:active' },
    { ...base, type: 'run.interrupt', runId: 'run:active', holdQueue: true },
    { ...base, type: 'queue.resume' },
    { commandId: base.commandId, type: 'thread.fork', sourceThreadId: threadId, targetThreadId: 'child:雪',
      sourcePoint: { type: 'run', runId: 'run:original' }, sideChat: true, createdBy: 'agent', creationSource: 'mcp' },
    { commandId: base.commandId, type: 'thread.merge_back', sourceThreadId: 'child:雪', targetThreadId: threadId,
      sourcePoint: { type: 'latest_stable' }, createdBy: 'agent', creationSource: 'mcp' },
  ]
  for (const command of commands) {
    let seen
    await withServices(executeSessionControl(request(command), provenance), input => {
      seen = input; return Effect.succeed(result)
    })
    assert.deepEqual(seen, Threads.withCreationProvenance(request(command).input, provenance))
    assert.equal(seen.commandId, command.commandId)
  }
})

test('preparation retry uses original launch service rather than command dispatch', async () => {
  const command = { ...base, type: 'prepared-run.retry', runId: 'run:prepared' }
  let retries = 0
  const value = await withServices(executeSessionControl(request(command), provenance),
    () => Effect.die('retry reached raw dispatch'), input => {
      assert.deepEqual(input, command); retries++; return Effect.succeed(result)
    })
  assert.deepEqual(value, { sequence: 73 })
  assert.equal(retries, 1)
})

test('launch uses original intake and stamps trusted provenance while preserving initial message identity', async () => {
  const input = { commandId: 'launch:original', threadId, projectId: 'project:1', title: 'Synthetic thread',
    modelSelection: { instanceId: 'synthetic:provider', model: 'never-executed' },
    runtimeMode: 'approval-required', interactionMode: 'default', workspaceStrategy: { type: 'root' },
    creationSource: 'mcp', initialMessage: { messageId: 'message:original', text: '  přesně\n', attachments: [] } }
  const decoded = Schema.decodeUnknownSync(ExecutorT3Request)({ ...routing,
    method: 'orchestration.launchThread', commandId: input.commandId, input })
  let seen
  await assert.rejects(Effect.runPromise(executeSessionControl(decoded, provenance).pipe(Effect.provide(
    Layer.mock(Launch.ThreadLaunchService)({ launch: received => {
      seen = received
      return Effect.fail(new Launch.ThreadLaunchError({ operation: 'create-thread',
        commandId: received.commandId, projectId: received.projectId, cause: 'synthetic post-commit failure' }))
    } }),
  ))))
  assert.deepEqual(seen, { ...input, ...provenance })
})

test('internal completion acknowledgements, sealed answers, mismatched IDs and routing are refused', () => {
  for (const input of [
    { commandId: base.commandId, type: 'delegated_task.completion-delivery.acknowledge',
      parentThreadId: threadId, taskId: 'task:1', observedByRunId: null },
    { ...base, type: 'runtime-request.respond', requestId: 'question:1', answers: { q: ['no secret'] } },
  ]) assert.throws(() => request(input))
  const decoded = request({ ...base, type: 'queue.resume' })
  assert.throws(() => validateControlRequest({ ...decoded, commandId: 'different' }))
  assert.throws(() => validateControlRequest({ ...decoded, sourceThreadId: 'other:thread' }))
})

test('a post-commit dispatch failure remains the original typed error and is never retried here', async () => {
  let calls = 0
  const value = executeSessionControl(request({ ...base, type: 'queue.resume' }), provenance)
  const failed = withServices(value, command => {
    calls++
    return Effect.fail(new Orchestrator.OrchestratorDispatchError({ commandId: command.commandId,
      commandType: command.type, cause: 'synthetic failure after possible commit' }))
  })
  await assert.rejects(failed)
  assert.equal(calls, 1)
})

test('finite delegated-work wait retains timeout and resultRun without acknowledging or stopping a child', async () => {
  const input = { projectId: S.ProjectId.make('project:1'), threadId: S.ThreadId.make(threadId),
    timeoutMs: 100, untilDelegatedWorkSettled: true }
  const expected = { threadId, run: null, timedOut: true }
  const value = await Effect.runPromise(waitForSessionWork(input).pipe(Effect.provide(
    Layer.mock(Threads.ThreadManagementService)({ waitForThread: received => {
      assert.deepEqual(received, input); return Effect.succeed(expected)
    } }),
  )))
  assert.deepEqual(value, expected)
})

test('tool descriptors keep original schemas, finite/stream distinction and owner-only schedules', () => {
  for (const operation of Object.values(sessionControlToolOperations)) {
    assert.equal(operation.descriptor._tag, operation.method)
    assert.equal(operation.binding, 'required')
    if (operation.method.startsWith('scheduledTasks.')) assert.equal(operation.authority, 'owner')
  }
  assert.equal(sessionControlToolOperations.schedules.delivery, 'stream')
  assert.equal(sessionControlToolOperations.scheduleRunNow.retry, 'transport-reconciliation')
  assert.equal(sessionControlToolOperations.dispatch.retry, 'original-command')
})
