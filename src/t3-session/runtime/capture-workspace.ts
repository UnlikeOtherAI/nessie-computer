import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import * as SqlClient from 'effect/sql/SqlClient'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { Sqlite } from '@nessie/t3-session-source/engine'
import type { OwnedCaptureStage, OwnedCaptureWorkspacePort } from '../import/materialize.js'
import { T3CaptureJournal } from '../state/journal.js'
import { requireCapture } from '../state/sqlite.js'
import { ownDatabaseFile } from './database-file.js'
import { acquireSessionStateWriter } from './ownership.js'
import { resolveT3SessionStateDir, assertOutsideCheckout } from './paths.js'
import { recognizeT3ExecutionDestination, type T3ExecutionDestinationScope } from '../source/execution-destination.js'

export interface OwnedSnapshotWorkspace {
  readonly workspace: OwnedCaptureWorkspacePort
  readonly journal: T3CaptureJournal
  readonly signal: AbortSignal
  /** Minted only after this process acquired the exclusive destination writer. */
  readonly runtimeGeneration: string
  assertCurrent(): void
}
export type RetainedCaptureWorkspace = OwnedSnapshotWorkspace

/**
 * Actual private capture destination, outside the checkout. One writer owns the
 * journal and stages for a physical source. Each destination SQL layer builds
 * once and stays held through capture, hydration, publication and lane reads.
 * This owns passive copies only; it starts no session engine worker/provider.
 */
export async function withRetainedCaptureWorkspace<A>(stateDirectory: string, physicalRootKey: string,
  use: (storage: RetainedCaptureWorkspace) => Promise<A>, caller: AbortSignal): Promise<A> {
  caller.throwIfAborted()
  const directory = await resolveT3SessionStateDir(stateDirectory, `retained-capture:${physicalRootKey}`)
  return withSnapshotWorkspaceAtDirectory(directory, use, caller)
}

/** Recognized native namespace before original SQL opens. Passive storage never
 * acquires this owner or promotes itself into an execution destination. */
export async function withPinnedExecutionWorkspace<A>(destination: T3ExecutionDestinationScope,
  use: (storage: OwnedSnapshotWorkspace) => Promise<A>, caller: AbortSignal): Promise<A> {
  recognizeT3ExecutionDestination(destination)
  const directory = destination.directory
  await assertOutsideCheckout(directory)
  recognizeT3ExecutionDestination(destination)
  return withSnapshotWorkspaceAtDirectory(directory, use,
    AbortSignal.any([caller, destination.signal]), destination)
}

async function withSnapshotWorkspaceAtDirectory<A>(directory: string,
  use: (storage: OwnedSnapshotWorkspace) => Promise<A>, caller: AbortSignal,
  destination?: T3ExecutionDestinationScope): Promise<A> {
  caller.throwIfAborted()
  const writer = await acquireSessionStateWriter(directory)
  const runtimeGeneration = destination?.receipt.runtimeGeneration ?? randomUUID()
  const lifetime = new AbortController()
  const signal = AbortSignal.any([caller, lifetime.signal])
  let scopes: Awaited<ReturnType<typeof makeSqlScope>> | undefined
  const checks = new Set<() => void>()
  const stages = new Map<string, Promise<OwnedCaptureStage>>()
  let journalDatabase: DatabaseSync | undefined
  let active = true
  let failed = false
  let failure: unknown
  const assertCurrent = () => {
    try {
      if (failed) throw failure
      signal.throwIfAborted()
      requireCapture(active, 'retained_capture_workspace_closed')
      writer.assertCurrent()
      if (destination) recognizeT3ExecutionDestination(destination)
      for (const check of checks) check()
    } catch (error) {
      if (!failed) { failed = true; failure = error }
      lifetime.abort(error)
      throw error
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined
  let result: A | undefined
  let useFailed = false
  let useFailure: unknown
  const cleanupErrors: unknown[] = []
  try {
    const sqlScope = await makeSqlScope()
    scopes = sqlScope
    assertCurrent()
    const journalPath = join(directory, 'capture-journal.sqlite')
    checks.add(await ownDatabaseFile(journalPath, 'create-or-open'))
    destination?.holdFile('journal')
    assertCurrent()
    journalDatabase = new DatabaseSync(journalPath, { enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false })
    const journal = new T3CaptureJournal(journalDatabase)
    assertCurrent()
    const acquire = (reference: string, create: boolean): Promise<OwnedCaptureStage> => {
      assertCurrent()
      requireCapture(/^t3-capture:v1:[a-f0-9]{64}$/u.test(reference), 'capture_stage_reference_invalid')
      const existing = stages.get(reference)
      requireCapture(!create || !existing, 'capture_destination_not_fresh')
      if (existing) return existing
      const opening = (async () => {
        const path = join(directory, `capture-${reference.slice('t3-capture:v1:'.length)}.sqlite`)
        checks.add(await ownDatabaseFile(path, create ? 'create' : 'existing'))
        destination?.holdFile(reference)
        assertCurrent()
        const layer = Sqlite.layerFromPath(path).pipe(
          Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
        const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.provideService(Scope.Scope, sqlScope)),
          { signal })
        assertCurrent()
        const sql = Context.get(context, SqlClient.SqlClient)
        return Object.freeze({ reference, sql: Layer.effect(SqlClient.SqlClient,
          Effect.sync(() => { assertCurrent(); return sql })) })
      })()
      // Retain failed acquisitions too. Retrying cannot reopen a partly written
      // generation as fresh; the journal's capture/recovery rules decide that.
      stages.set(reference, opening)
      void opening.catch(() => undefined)
      return opening
    }
    const workspace: OwnedCaptureWorkspacePort = Object.freeze({
      createGeneration: async (generation: string) => {
        requireCapture(generation.length > 0 && Buffer.byteLength(generation) <= 512, 'capture_generation_invalid')
        const key = createHash('sha256').update('nessie:t3-capture-stage:v1\0').update(generation).digest('hex')
        return acquire(`t3-capture:v1:${key}`, true)
      },
      reopenGeneration: async (reference: string) => acquire(reference, false),
    })
    timer = setInterval(() => { try { assertCurrent() } catch { /* Sticky signal closes dependent graph. */ } }, 1000)
    timer.unref()
    result = await use(Object.freeze({ workspace, journal, signal, runtimeGeneration, assertCurrent }))
    assertCurrent()
  } catch (error) { useFailed = true; useFailure = error }
  finally {
    if (timer) clearInterval(timer)
    active = false
    lifetime.abort()
    // Scope.close joins original SQL finalizers before either journal or writer
    // closes. No capture file or lock is deleted, including on partial failure.
    await Promise.allSettled([...stages.values()])
    if (scopes) {
      try { await Effect.runPromise(Scope.close(scopes, Exit.void)) } catch (error) { cleanupErrors.push(error) }
    }
    try { journalDatabase?.close() } catch (error) { cleanupErrors.push(error) }
    try { writer.close() } catch (error) { cleanupErrors.push(error) }
  }
  const errors = [...(useFailed ? [useFailure] : []),
    ...(failed && failure !== useFailure ? [failure] : []), ...cleanupErrors]
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'retained_capture_workspace_failed')
  return result as A
}

const makeSqlScope = () => Effect.runPromise(Scope.make('sequential'))
