import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { createSourceModuleLoader } from '../t3-session-client-connection/module-loader.mjs'
import { sourceFunctions } from '../t3-session-client-connection/source-functions.mjs'
import { readRequestSource, scratch } from './source-fixture.mjs'

const { snapshot, privacy } = await readRequestSource()
const loader = createSourceModuleLoader(snapshot, { dependencyDirectory: resolve(scratch, 'dependencies') })
const Effect = await loader.external('effect/Effect')
const Queue = await loader.external('effect/Queue')
const file = 'apps/server/src/provider/EventNdjsonLogger.ts'
const claude = 'apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts'
const codex = 'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts'
const canary = ['synthetic', 'C05', 'log', '🧭'].join('-')
const noCanary = value => assert.equal(JSON.stringify(value).includes(canary), false)
const types = sourceFunctions(snapshot, file, 'const transientCanonicalEventTypes =',
  'export type EventNdjsonStream', ['transientCanonicalEventTypes', 'transientNativeMethods', 'transientAcpUpdates'])
const { shouldPersistProviderEvent } = sourceFunctions(snapshot, file, 'export function shouldPersistProviderEvent(',
  'const summaryFields =', ['shouldPersistProviderEvent'], types)
const bounds = sourceFunctions(snapshot, file, 'const summaryFields =', 'export const writeBatchedMessages',
  ['summarizeProviderEvent', 'boundProviderEventForLogging'], {
    MAX_RECORD_CHARACTERS: 65536, MAX_RECORD_FIELDS: 1024, MAX_RECORD_DEPTH: 16,
  })
const { redactCodexProtocolValue } = sourceFunctions(snapshot, codex, 'function redactCodexProtocolValue(',
  'export const layerAppServerClientFactory:', ['redactCodexProtocolValue'], {
    boundProviderEventForLogging: bounds.boundProviderEventForLogging, pipe: (v, ...fs) => fs.reduce((v, f) => f(v), v),
  })

for (const [name, path, from, until, exportName] of [
  ['Claude', claude, 'function makeClaudeAgentSdkProtocolLogger(', 'const encodeClaudeJson =', 'makeClaudeAgentSdkProtocolLogger'],
  ['Codex', codex, 'export function makeCodexAppServerProtocolLogger(', 'function redactCodexProtocolValue(', 'makeCodexAppServerProtocolLogger'],
]) {
  test(`actual ${name} protocol logger projects before original bounds and summary fallback`, async () => {
    const logs = []
    const fn = sourceFunctions(snapshot, path, from, until, [exportName], {
      ...privacy, ...bounds, Effect, shouldPersistProviderEvent, redactCodexProtocolValue,
      CLAUDE_PROVIDER: 'claude', CODEX_PROVIDER: 'codex', CLAUDE_AGENT_SDK_QUERY_PROTOCOL: 'claude.agent-sdk.query',
    })[exportName]
    const logger = fn({ threadId: 'thread:opaque', providerSessionId: 'provider:opaque', nativeEventLogger: {
      write: (event, threadId) => Effect.sync(() => logs.push({ event, threadId })),
    } })
    assert.equal(fn({ nativeEventLogger: undefined }), undefined)
    await Effect.runPromise(logger({ stage: 'decoded', direction: 'incoming', payload: {
      type: 'assistant', message: { content: [{ type: 'tool_use', id: 'secret-call',
        name: 'mcp__t3_code__request_secret', input: { value: canary, label: 'Token' } }] },
    } }))
    await Effect.runPromise(logger({ stage: 'decoded', payload: { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'secret-call', content: canary, is_error: true },
    ] } } }))
    await Effect.runPromise(logger({ stage: 'decoded', payload: { id: 'secret-call', error: { message: canary } },
      padding: 'x'.repeat(70000) }))
    noCanary(logs)
    assert.equal(logs.length, 3)
    assert.equal(logs[0].event.providerSessionId, 'provider:opaque')
    assert.equal(logs[1].event.event.payload.message.content[0].tool_use_id, 'secret-call')
    assert.equal(logs[2].event.event.truncated, true, 'the real original summary fallback was exercised')
    await Effect.runPromise(logger({ stage: 'decoded', payload: { method: 'item/agentMessage/delta', params: { delta: canary } } }))
    assert.equal(logs.length, 3, 'existing transient logging policy is preserved')
  })
}

test('actual adapter publication functions protect late app-output overrides and preserve control events', async () => {
  for (const [path, until, bindings] of [
    [codex, '        const emitImageWorkState', {}],
    [claude, '        const persistAttachmentBudget', { pdfBudgets: new Map() }],
  ]) {
    await Effect.runPromise(Effect.gen(function* () {
      const events = yield* Queue.unbounded()
      const { emitProviderEvent } = sourceFunctions(snapshot, path, '        const emitProviderEvent =', until,
        ['emitProviderEvent'], { ...privacy, ...bindings, events, Effect, Queue })
      const secretEvent = { type: 'turn_item.updated', driver: 'synthetic', turnItem: {
        type: 'dynamic_tool', toolName: 't3-code.request_secret', input: { value: canary },
        output: { app: { preview: canary }, error: { message: canary } }, id: '__proto__', ordinal: 4, status: 'failed',
      } }
      yield* emitProviderEvent(secretEvent)
      const control = { type: 'node.updated', driver: 'synthetic', node: { id: 'opaque', status: 'running' } }
      yield* emitProviderEvent(control)
      const published = yield* Queue.take(events)
      noCanary(published)
      assert.equal(published.turnItem.id, '__proto__')
      assert.equal(published.turnItem.ordinal, 4)
      assert.equal(published.turnItem.status, 'failed')
      assert.equal((yield* Queue.take(events)), control)
      assert.equal(secretEvent.turnItem.input.value, canary, 'source event remains untouched')
    }))
  }
})
