import { RetainedImportLeaseSchema, type RetainedImportLease } from '@nessie/executor-protocol'
import { captureRetainedT3, resumeRetainedT3, type RetainedCapturePorts } from '../import/capture.js'
import { withHeldRetainedCatalogGraph, type HeldRetainedCatalogGraph } from '../catalog/held-graph.js'
import { machineT3Sources } from '../source/owner.js'
import { requireCapture } from '../state/sqlite.js'
import { withRetainedRuntimeSource, type HeldRetainedRuntimeSource } from './retained-source.js'
import { withRetainedCaptureWorkspace, type RetainedCaptureWorkspace } from './capture-workspace.js'

export interface CapturedRetainedRuntime {
  readonly held: HeldRetainedRuntimeSource
  readonly graph: HeldRetainedCatalogGraph
  readonly storage: RetainedCaptureWorkspace
}

/**
 * Internal production handoff for a real tray snapshot and separately issued
 * canonical capture lease. A serialized receipt alone never grants reading.
 * The real local producer consumes consent and the actual authority checks its
 * lease at every capture boundary. No user identities or source rows are invented.
 */
export async function withCapturedRetainedRuntime<A>(stateDirectory: string,
  input: { readonly challenge: unknown; readonly receipt: unknown; readonly captureLease: RetainedImportLease },
  use: (runtime: CapturedRetainedRuntime) => Promise<A>, caller: AbortSignal): Promise<A> {
  const lease = RetainedImportLeaseSchema.parse(input.captureLease)
  requireCapture(lease.purpose === 'capture', 'retained_import_wrong_purpose')
  return withRetainedRuntimeSource(stateDirectory, input, held =>
    withRetainedCaptureWorkspace(stateDirectory, held.local.source.physicalRootKey, async storage => {
      const signal = AbortSignal.any([held.signal, storage.signal])
      const local = held.local
      requireCapture(lease.captureGeneration === local.captureGeneration, 'retained_capture_generation_mismatch')
      const manifest = await held.checked(() => machineT3Sources(local.challenge.executorId).manifest())
      const ports: RetainedCapturePorts = {
        workspace: storage.workspace, journal: storage.journal, importRead: local.authority(lease),
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
      return withHeldRetainedCatalogGraph(ports, local, graph => use({ held, graph, storage }), signal)
    }, held.signal), caller)
}
