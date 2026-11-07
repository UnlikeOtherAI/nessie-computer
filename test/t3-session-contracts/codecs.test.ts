import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import * as Schema from 'effect/Schema'
import * as DateTime from 'effect/DateTime'
import * as C from '../../packages/t3-session-source/dist/contracts.js'
import { ExecutorT3Request, ExecutorT3Result, ExecutorT3Error, ExecutorT3Descriptors,
  decodeExecutorT3Request, encodeExecutorT3Request, requireExecutorT3Correlation,
  commandTargets, httpQuery, ExecutorT3HttpEndpoints, ClientCommand,
  requireBoundExecutorT3Operation, requestTargets, ExecutorT3SealedAnswerDescriptor,
  ExecutorT3HttpRequest, ExecutorT3HttpFailure } from '@nessie/executor-protocol/t3-session'

const route = { transportVersion: 1, protocolVersion: 2,
  sourceRevision: '25bf84ab07f53f141c20239c63e383823a9d5ea0', executorId: randomUUID(),
  environmentId: 'environment:opaque/not-uuid', connectionEpoch: '9007199254740993',
  runtimeGeneration: 'generation:one', correlationId: 'request:one', relayOrdinal: 17 }
const read = () => decodeExecutorT3Request({ ...route, kind: 'request',
  method: 'orchestration.getThreadProjection', input: { threadId: 'thread:opaque/not-uuid' } })

test('all 21 original orchestration descriptors are selected, including both map omissions', () => {
  assert.equal(Object.keys(C.ORCHESTRATION_V2_WS_METHODS).length, 21)
  assert.equal(Object.keys(C.OrchestrationV2RpcSchemas).length, 19)
  for (const tag of Object.values(C.ORCHESTRATION_V2_WS_METHODS)) assert.ok(tag in ExecutorT3Descriptors)
  assert.ok(!('orchestration.replayEvents' in ExecutorT3Descriptors))
  for (const method of ['orchestration.searchThreads', 'orchestration.searchThreadStream']) {
    const input = method === 'orchestration.searchThreads' ? { query: 'hledání' }
      : { threadId: 'thread:opaque', query: 'hledej', index: 0 }
    assert.equal(decodeExecutorT3Request({ ...route, kind: 'request', method, input }).method, method)
  }
})

test('original codecs reject wrong-method bodies and unclassified methods', () => {
  assert.throws(() => decodeExecutorT3Request({ ...route, kind: 'request', method: 'orchestration.getThreadProjection',
    input: { threadIds: ['thread:opaque'] } }))
  assert.throws(() => decodeExecutorT3Request({ ...route, kind: 'request', method: 'server.getUsageSummary', input: {} }))
  assert.throws(() => decodeExecutorT3Request({ ...route, kind: 'request', method: 'orchestration.getThreadProjection',
    input: { threadId: ' ' } }))
  assert.equal(read().connectionEpoch, '9007199254740993')
})

test('HTTP string negotiation and RPC boolean negotiation remain different', () => {
  const query = httpQuery(ExecutorT3HttpEndpoints.threadBoundedSnapshot)
  assert.deepEqual(Schema.decodeUnknownSync(query)({ compactIds: '1', deferWork: 'true' }),
    { compactIds: '1', deferWork: 'true' })
  assert.throws(() => Schema.decodeUnknownSync(query)({ compactIds: true }))
  const request = { ...route, kind: 'request', method: 'orchestration.subscribeThread',
    input: { threadId: 'opaque', acceptCompactIds: true, afterSequence: 5 } }
  assert.equal(decodeExecutorT3Request(request).method, 'orchestration.subscribeThread')
  assert.throws(() => decodeExecutorT3Request({ ...request, input: { ...request.input, acceptCompactIds: '1' } }))
})

test('original date and compact ID-table codecs survive transport round trips', () => {
  const command = Schema.decodeUnknownSync(C.OrchestrationV2Command)({ type: 'thread.settle',
    threadId: 'thread:opaque', commandId: 'command:date', settledAt: DateTime.makeUnsafe('2026-11-07T12:00:00Z') })
  const request = Schema.decodeUnknownSync(ExecutorT3Request)({ ...route, kind: 'request',
    method: 'orchestration.dispatchCommand', commandId: command.commandId, input: command })
  const encoded = encodeExecutorT3Request(request)
  assert.match(JSON.stringify(encoded), /2026-11-07T12:00:00/)
  const decoded = decodeExecutorT3Request(encoded)
  assert.equal(decoded.method, 'orchestration.dispatchCommand')
  const history = Schema.toCodecJson(C.OrchestrationV2ThreadHistoryPage)
  const page = Schema.decodeUnknownSync(C.OrchestrationV2ThreadHistoryPage)({ snapshotSequence: 4,
    items: [{ position: 0, visibility: 'local', sourceThreadId: 'thread:opaque', sourceItemId: 'item:opaque',
      item: { id: 'item:opaque', threadId: 'thread:opaque', type: 'system_notice', message: 'synthetic',
        runId: null, nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null,
        parentItemId: null, ordinal: 0, status: 'completed', title: null, startedAt: null,
        completedAt: null, updatedAt: '2026-11-07T12:00:00Z' } }],
    nextCursor: null, hasMoreHistory: false, idTable: true })
  const wire = Schema.encodeSync(history)(page)
  assert.ok(wire && typeof wire === 'object' && 'ids' in wire && Array.isArray(wire.ids) && wire.ids.length > 0)
  const restored = Schema.decodeUnknownSync(history)(wire)
  assert.equal(restored.snapshotSequence, 4)
  assert.equal(restored.items[0]?.sourceThreadId, 'thread:opaque')
  assert.equal(restored.items[0]?.item.id, 'item:opaque')
})

test('stream elements, finite results and errors retain method correlation', () => {
  const stream = Schema.decodeUnknownSync(ExecutorT3Result)({ ...route, kind: 'stream',
    method: 'orchestration.subscribeThread', result: { kind: 'synchronized' } })
  assert.equal(stream.kind, 'stream')
  assert.throws(() => Schema.decodeUnknownSync(ExecutorT3Result)({ ...route, kind: 'result',
    method: 'orchestration.subscribeThread', result: { kind: 'synchronized' } }))
  const reply = Schema.decodeUnknownSync(ExecutorT3Error)({ ...route, kind: 'error',
    method: 'orchestration.getThreadProjection', error: new C.OrchestrationV2GetThreadProjectionError({ threadId: C.ThreadId.make('opaque'), message: 'synthetic failure' }) })
  requireExecutorT3Correlation(read(), reply)
  for (const change of [{ correlationId: 'other' }, { environmentId: C.EnvironmentId.make('other') },
    { runtimeGeneration: 'other' }, { connectionEpoch: '9007199254740994' }]) {
    assert.throws(() => requireExecutorT3Correlation(read(), { ...reply, ...change }))
  }
})

test('internal prepared-run and provider records are denied even when the public source union accepts them', () => {
  const input = { type: 'prepared-run.progress', commandId: 'command:one', threadId: 'thread:one', runId: 'run:one', phase: 'setup' }
  assert.doesNotThrow(() => Schema.decodeUnknownSync(C.OrchestrationV2Command)(input))
  assert.throws(() => Schema.decodeUnknownSync(ClientCommand)(input))
  assert.throws(() => decodeExecutorT3Request({ ...route, kind: 'request', commandId: 'command:one',
    method: 'orchestration.dispatchCommand', input }))
  assert.throws(() => requireBoundExecutorT3Operation({}, 'orchestration.launchThread'), /NOT_BOUND/)
})

test('fork, merge and message references supply every affected authority target', () => {
  const fork = Schema.decodeUnknownSync(C.OrchestrationV2Command)({ type: 'thread.fork', createdBy: 'user', creationSource: 'mobile',
    commandId: 'command:fork', sourceThreadId: 'source:one', targetThreadId: 'target:one', sourcePoint: { type: 'latest_stable' } })
  assert.deepEqual(commandTargets(fork), [{ kind: 'thread', id: 'source:one', scope: 'existing' },
    { kind: 'thread', id: 'target:one', scope: 'create' }])
  const request = decodeExecutorT3Request({ ...route, kind: 'request', method: 'orchestration.getThreadTitles',
    input: { threadIds: ['source:one', 'target:two'] } })
  assert.equal(requestTargets(request).length, 2)
  const mismatch = decodeExecutorT3Request({ ...route, kind: 'request', method: 'orchestration.dispatchCommand',
    sourceThreadId: 'unrelated:thread', commandId: 'command:archive',
    input: { type: 'thread.archive', commandId: 'command:archive', threadId: 'actual:thread' } })
  assert.throws(() => requestTargets(mismatch), /ROUTE_TARGET_MISMATCH/)
})

test('ordinary transport refuses secret answers and original command ID mismatches', () => {
  assert.throws(() => decodeExecutorT3Request({ ...route, kind: 'request', method: 'secrets.answerRequest',
    input: { threadId: 'thread:one', turnItemId: 'item:one', answer: { type: 'save', secret: 'synthetic' } } }))
  assert.throws(() => decodeExecutorT3Request({ ...route, kind: 'request', method: 'orchestration.dispatchCommand',
    commandId: 'command:other', input: { type: 'thread.archive', threadId: 'thread:one', commandId: 'command:one' } }))
  assert.throws(() => Schema.decodeUnknownSync(ExecutorT3SealedAnswerDescriptor, { onExcessProperty: 'error' })({
    ...route, kind: 'sealed-answer', method: 'secrets.answerRequest', threadId: 'thread:one', turnItemId: 'item:one',
    lane: 'executor-session-action', actionId: randomUUID(), commandId: 'command:secret',
    vaultPersistence: { state: 'not_required' }, secret: 'synthetic' }))
})

test('HTTP envelopes preserve source headers, query values, status and exact error body', () => {
  const request = { ...route, kind: 'http-request', endpoint: 'threadHistoryPage', params: { threadId: 'opaque:thread' },
    query: { cursor: 'opaque:cursor', compactIds: '1' }, headers: { 'x-t3-orchestration-protocol': '2' } }
  assert.equal(Schema.decodeUnknownSync(ExecutorT3HttpRequest)(request).endpoint, 'threadHistoryPage')
  assert.throws(() => Schema.decodeUnknownSync(ExecutorT3HttpRequest)({ ...request,
    headers: { ...request.headers, authorization: 'must-stay-in-gateway' } }))
  const body = new C.EnvironmentResourceNotFoundError({ code: 'not_found',
    reason: 'thread_not_found', traceId: 'synthetic-trace' })
  const reply = { ...route, kind: 'http-error', endpoint: 'threadHistoryPage', status: 404,
    headers: { 'x-t3-orchestration-protocol': '2' }, body }
  assert.equal(Schema.decodeUnknownSync(ExecutorT3HttpFailure)(reply).status, 404)
  assert.throws(() => Schema.decodeUnknownSync(ExecutorT3HttpFailure)({ ...reply, status: 500 }))
  assert.equal(Schema.decodeUnknownSync(ExecutorT3HttpFailure)({ ...reply, status: 401,
    body: new C.EnvironmentAuthInvalidError({ code: 'auth_invalid', reason: 'missing_credential',
      traceId: 'synthetic-trace' }) }).status, 401)
})

test('message context and plan references retain cross-environment and file targets', () => {
  const command = Schema.decodeUnknownSync(C.OrchestrationV2Command)({ type: 'message.dispatch',
    commandId: 'command:context', messageId: 'message:context', createdBy: 'user', creationSource: 'mobile',
    threadId: 'current:thread', text: 'prosím zkontroluj, pls', attachments: [], dispatchMode: { type: 'start_immediately' },
    sourcePlanRef: { threadId: 'plan:thread', planId: 'plan:one' },
    context: { version: 1, records: [{ version: 1, contextId: 'ctx1', label: 'Referenced thread', kind: 'thread',
      environmentId: 'other:computer', threadId: 'other:thread', title: 'Synthetic' },
    { version: 1, contextId: 'ctx2', label: 'File', kind: 'file', attachmentId: 'file1',
      name: 'fixture.txt', mimeType: 'text/plain', sizeBytes: 3 }] } })
  const targets = commandTargets(command)
  assert.ok(targets.some(target => target.id === 'plan:thread'))
  assert.ok(targets.some(target => target.id === 'other:thread' && target.environmentId === 'other:computer'))
  assert.ok(targets.some(target => target.kind === 'attachment' && target.id === 'file1'))
})

test('nested settings and refresh policies reject mixed side effects before admission', () => {
  const settings = { ...route, kind: 'request', method: 'server.updateSettings', commandId: 'settings:one',
    input: { patch: { setModelFavorites: [{ provider: 'provider_one', model: 'synthetic', favorite: true }] } } }
  assert.equal(decodeExecutorT3Request(settings).method, 'server.updateSettings')
  assert.ok(requestTargets(decodeExecutorT3Request(settings)).some(target => target.id === 'provider_one'))
  assert.throws(() => decodeExecutorT3Request({ ...settings,
    input: { patch: { ...settings.input.patch, enableDeviceSupport: true } } }))
  assert.throws(() => decodeExecutorT3Request({ ...settings, input: { patch: { cloudSpeechCredentials: {} } } }))
  const refresh = { ...route, kind: 'request', method: 'server.refreshProviders', input: {} }
  assert.equal(decodeExecutorT3Request(refresh).method, 'server.refreshProviders')
  assert.throws(() => decodeExecutorT3Request({ ...refresh, input: { refreshModels: true } }))
  assert.equal(decodeExecutorT3Request({ ...refresh, commandId: 'refresh:one', input: { refreshModels: true } }).commandId, 'refresh:one')
  assert.throws(() => decodeExecutorT3Request({ ...refresh, commandId: 'refresh:one', input: { reloadSecrets: true } }))
})

test('interactive MCP targets and stored task identities require all resource owners', () => {
  const request = decodeExecutorT3Request({ ...route, kind: 'request', method: 'mcpApps.updateModelContext',
    commandId: 'mcp:one', input: { threadId: 'producing:thread', itemId: 'producing:item',
      conversationThreadId: 'destination:thread' } })
  const targets = requestTargets(request)
  assert.deepEqual(targets.filter(target => target.kind === 'thread').map(target => target.id),
    ['producing:thread', 'destination:thread'])
  assert.ok(targets.some(target => target.kind === 'turn-item' && target.id === 'producing:item'))
  const task = decodeExecutorT3Request({ ...route, kind: 'request', method: 'scheduledTasks.setEnabled',
    commandId: 'task:one', input: { id: 'stored:task', enabled: true } })
  assert.deepEqual(requestTargets(task), [{ kind: 'scheduled-task', id: 'stored:task', scope: 'resolve' }])
})

test('unknown original events advance the cursor but cannot be re-encoded as server events', () => {
  const codec = Schema.toCodecJson(C.OrchestrationV2ThreadStreamItem)
  const unknown = Schema.decodeUnknownSync(codec)({ kind: 'event', sequence: 23,
    event: { type: 'future.source.event', payload: { threadId: 'opaque' } } })
  assert.deepEqual(unknown, { kind: 'unknown-event', sequence: 23, eventType: 'future.source.event' })
  assert.throws(() => Schema.encodeSync(codec)(unknown))
  assert.throws(() => Schema.decodeUnknownSync(codec)({ kind: 'event', sequence: 24,
    event: { type: 'thread.created', payload: {} } }))
})

test('scheduled signature plaintext and one-use references stay outside ordinary transport', () => {
  const task = { ...route, kind: 'request', method: 'scheduledTasks.upsert', commandId: 'task:save',
    input: { title: 'Synthetic', prompt: 'prosím proveď úlohu', enabled: true,
      schedule: { type: 'webhook', signature: { header: 'x-signature', encoding: 'hex', prefix: '' } },
      projectId: 'project:one', workspaceStrategy: { type: 'root' },
      modelSelection: { instanceId: 'provider_one', model: 'synthetic' }, runtimeMode: 'full-access', interactionMode: 'default' } }
  assert.equal(decodeExecutorT3Request(task).method, 'scheduledTasks.upsert')
  for (const sensitive of [{ secret: 'synthetic-secret' }, { secretRef: 'opaque:reference' }]) {
    const input = { ...task.input, schedule: { ...task.input.schedule,
      signature: { ...task.input.schedule.signature, ...sensitive } } }
    assert.doesNotThrow(() => Schema.decodeUnknownSync(ExecutorT3Descriptors['scheduledTasks.upsert'].payloadSchema)(input))
    assert.throws(() => decodeExecutorT3Request({ ...task, input }))
  }
})
