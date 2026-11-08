import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import { HeldSessionExecutionGraph, recognizeSessionExecutionGraph }
  from '../../dist/t3-session/runtime/execution-graph.js'
import { readSessionExecutionResources } from '../../dist/t3-session/runtime/execution-resources.js'

test('serialized graph evidence cannot manufacture the live original graph record', async () => {
  assert.throws(() => new HeldSessionExecutionGraph({}, {}), /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
  const forged = Object.create(HeldSessionExecutionGraph.prototype)
  assert.throws(() => forged.receipt, /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
  await assert.rejects(Effect.runPromise(recognizeSessionExecutionGraph(forged, {}, {
    requestDigest: 'hmac-sha256:' + 'a'.repeat(64), executionGraph: {},
    provenance: { createdBy: 'user', creationSource: 'web' },
  })), /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
})

test('caller supplied recheck and settings never substitute for a native issued resource', async () => {
  let decoded = false, checked = false
  const source = {
    get settingsBytes() { decoded = true; return new TextEncoder().encode('{}') },
    receipt: {}, providerReferences: [], signal: new AbortController().signal,
    recheck: async () => { checked = true },
  }
  await assert.rejects(Effect.runPromise(readSessionExecutionResources(source, {})),
    /t3_execution_resource_not_issued/u)
  assert.equal(decoded, false)
  assert.equal(checked, false)
})
