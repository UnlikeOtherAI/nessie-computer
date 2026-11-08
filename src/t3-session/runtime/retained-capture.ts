import { captureRetainedT3, resumeRetainedT3, type RetainedCapturePorts } from '../import/capture.js'
import { withHeldRetainedCatalogGraph, type HeldRetainedCatalogGraph } from '../catalog/held-graph.js'
import { machineT3Sources } from '../source/owner.js'
import { requireCapture } from '../state/sqlite.js'
import { withRetainedRuntimeSource, type HeldRetainedRuntimeSource } from './retained-source.js'
import { withRetainedCaptureWorkspace, type RetainedCaptureWorkspace } from './capture-workspace.js'
import { withHeldRetainedLane } from './retained-lane.js'
import type { T3SessionLaneRuntime } from '../../t3-session-lane.js'

export interface CapturedRetainedRuntime {
  readonly held: HeldRetainedRuntimeSource
  readonly graph: HeldRetainedCatalogGraph
  readonly storage: RetainedCaptureWorkspace
  /** Attached to the existing daemon's transient registry only while this callback is held. */
  readonly lane: T3SessionLaneRuntime
  /** Observe this signal and drain the daemon lane before returning. */
  readonly signal: AbortSignal
}

/**
 * Internal production handoff for a real tray snapshot. Capture authority comes
 * only from the actual consent.commit activation inside the held callback.
 * A serialized receipt alone never grants reading. The authority checks its
 * lease at every capture boundary. No user identities or source rows are invented.
 */
export async function withCapturedRetainedRuntime<A>(stateDirectory: string,
  input: { readonly challenge: unknown; readonly receipt: unknown },
  use: (runtime: CapturedRetainedRuntime) => Promise<A>, caller: AbortSignal): Promise<A> {
  return withRetainedRuntimeSource(stateDirectory, input, held => {
    const local = held.local
    // Selected-thread bootstrap reads prove only their finite approved scope.
    // They cannot authorize this whole-source capture or inherited closure.
    requireCapture(local.challenge.selection.kind === 'whole_source', 'retained_import_capture_requires_whole_source')
    const importRead = local.bootstrapAuthority('capture')
    requireCapture(importRead.captureGeneration === local.captureGeneration, 'retained_capture_generation_mismatch')
    return withRetainedCaptureWorkspace(stateDirectory, local.source.physicalRootKey, async storage => {
      const signal = AbortSignal.any([held.signal, storage.signal])
      const manifest = await held.checked(() => machineT3Sources(local.challenge.executorId).manifest())
      const ports: RetainedCapturePorts = {
        workspace: storage.workspace, journal: storage.journal, importRead,
        source: {
          // The capture snapshot's existing port consumes this exact held
          // callback. It must not open a second source connection or substitute
          // a newly created recheck, which would lose native recognition.
          withReadonlySource: async (requested, key, read) => {
            requireCapture(requested === manifest && key === local.source.admittedRootKey,
              'retained_capture_source_substitution')
            signal.throwIfAborted()
            storage.assertCurrent()
            return held.checked(async () => {
              const result = await read(local.source, local.database, local.physicalSourceRecheck)
              storage.assertCurrent()
              signal.throwIfAborted()
              return result
            })
          },
        },
      }
      const existing = storage.journal.generation(local.captureGeneration)
      if (existing) {
        // Original recovery verifies source fingerprint/high-water and phase;
        // it never treats a partially written capture as a fresh destination.
        await resumeRetainedT3(ports, manifest, local.source.admittedRootKey, local.captureGeneration)
      } else {
        await captureRetainedT3(ports, manifest, local.source.admittedRootKey)
      }
      await held.recheck()
      storage.assertCurrent()
      signal.throwIfAborted()
      return withHeldRetainedCatalogGraph(ports, local, graph =>
        withHeldRetainedLane(stateDirectory, held, storage, graph,
          (lane, runtimeSignal) => use({ held, graph, storage, lane, signal: runtimeSignal })), signal)
    }, held.signal)
  }, caller)
}
