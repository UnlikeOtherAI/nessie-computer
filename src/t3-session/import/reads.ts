import * as Effect from 'effect/Effect'
import type { ThreadReadService,
  SourceContracts as S } from '@nessie/t3-session-source/engine'
import { readRetainedEffect } from '../catalog/scope.js'
import type { RetainedCapturePorts } from './capture.js'
import type { T3SourceManifest } from './manifest.js'

/** One guarded page per callback lifetime. This is not a gateway, credential,
 * live stream, original-owner producer or alternate history implementation.
 */
async function readPage<A>(ports: RetainedCapturePorts, manifest: T3SourceManifest, admittedRootKey: string,
  generation: string, threadId: S.ThreadId,
  read: (service: ThreadReadService['Service']) => Effect.Effect<A, unknown>) {
  const result = await Effect.runPromise(readRetainedEffect(ports,
    { manifest, admittedRootKey, generation }, [threadId], read))
  return result.value
}

export function readRetainedProjection(ports: RetainedCapturePorts, manifest: T3SourceManifest,
  admittedRootKey: string, generation: string, threadId: S.ThreadId) {
  return readPage(ports, manifest, admittedRootKey, generation, threadId,
    service => service.getThreadProjection(threadId))
}

export function readRetainedHistoryPage(ports: RetainedCapturePorts, manifest: T3SourceManifest,
  admittedRootKey: string, generation: string,
  ...input: Parameters<ThreadReadService['Service']['getThreadHistoryPage']>) {
  return readPage(ports, manifest, admittedRootKey, generation, input[0],
    service => service.getThreadHistoryPage(...input))
}

export function readRetainedSnapshotWindow(ports: RetainedCapturePorts, manifest: T3SourceManifest,
  admittedRootKey: string, generation: string,
  ...input: Parameters<ThreadReadService['Service']['getThreadSnapshotWindow']>) {
  return readPage(ports, manifest, admittedRootKey, generation, input[0],
    service => service.getThreadSnapshotWindow(...input))
}
