import assert from 'node:assert/strict'
import test from 'node:test'
import { withHeldRetainedLane } from '../../dist/t3-session/runtime/retained-lane.js'

// Refusal-only structural inputs. These never claim native consent, construct
// a readable source, or qualify a positive held graph. State loading is trapped.
const refusedGraph = () => {
  const source = Object.freeze({ environmentId: 'synthetic:environment', physicalRootKey: 'synthetic:root' })
  const signal = new AbortController().signal
  return {
    held: { signal, local: { source, captureGeneration: 'synthetic:capture' },
      checked: () => assert.fail('refused graph must not load enrollment') },
    storage: { signal, assertCurrent: () => {} },
    graph: { signal, source, captureGeneration: 'synthetic:capture', readiness: 'retained-read-only',
      recheck: () => assert.fail('refused graph must not open a read scope') },
  }
}

test('source substitution, generation substitution and executing readiness never expose a lane', async () => {
  for (const mutation of [
    graph => { graph.source = { ...graph.source } },
    graph => { graph.captureGeneration = 'synthetic:other-capture' },
    graph => { graph.readiness = 'executing' },
  ]) {
    const { held, storage, graph } = refusedGraph()
    mutation(graph)
    await assert.rejects(withHeldRetainedLane('never-open-this-path', held, storage, graph,
      () => assert.fail('invalid graph exposed a lane')), { code: 'retained_runtime_graph_substitution' })
  }
})

test('retired graph, source or writer refuses before enrollment and callback exposure', async () => {
  for (const target of ['held', 'storage', 'graph']) {
    const fixture = refusedGraph()
    const reason = new Error(`synthetic-${target}-retired`)
    fixture[target].signal = AbortSignal.abort(reason)
    await assert.rejects(withHeldRetainedLane('never-open-this-path', fixture.held, fixture.storage, fixture.graph,
      () => assert.fail('retired owner exposed a lane')), error => error === reason)
  }
})
