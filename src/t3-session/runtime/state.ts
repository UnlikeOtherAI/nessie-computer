import { lstat, open } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type * as SqlClient from 'effect/sql/SqlClient'
import { Sqlite } from '@nessie/t3-session-source/engine'
import { assertOwnerOnlyStatePath } from '../../state-security.js'
import { acquireSessionStateWriter } from './ownership.js'
import { SessionStateError } from './paths.js'
import { SessionStateOwner } from './state-owner.js'

const checkDatabasePaths = async (directory: string): Promise<string> => {
  const path = join(directory, 'state.v2.sqlite')
  try { await (await open(path, 'wx', 0o600)).close() }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = path + suffix
    const entry = await lstat(file).catch(error => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      return null
    })
    if (!entry) continue
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
      throw new SessionStateError('session_database_shape_refused')
    }
    await assertOwnerOnlyStatePath(file, 'file')
  }
  return path
}

/**
 * Own SQLite for the complete supplied effect, including its scoped finalizers.
 * The native runtime owner must already hold custody/clearance before invoking
 * an executing effect here. This function does not authorize or start providers.
 * A lock replacement interrupts the scope instead of merely logging a warning.
 */
export const withOwnedSessionState = <A, E, R>(directory: string,
  use: Effect.Effect<A, E, R | SqlClient.SqlClient | SessionStateOwner>) => Effect.scoped(Effect.gen(function* () {
  const writer = yield* Effect.acquireRelease(
    Effect.tryPromise(() => acquireSessionStateWriter(directory)),
    value => Effect.sync(() => value.close()),
  )
  const path = yield* Effect.tryPromise(() => checkDatabasePaths(writer.directory))
  const identity = yield* Effect.try(() => lstatSync(path, { bigint: true }))
  const sql = Sqlite.layerFromPath(path).pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  )
  let open = true
  let lost = false
  yield* Effect.addFinalizer(() => Effect.sync(() => { open = false }))
  const check = Effect.try({ try: () => {
    if (!open || lost) throw new SessionStateError('session_state_ownership_lost')
    writer.assertCurrent()
    const current = lstatSync(path, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
      || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new SessionStateError('session_database_replaced')
    }
  }, catch: cause => {
    lost = true
    return cause instanceof SessionStateError ? cause : new SessionStateError('session_state_ownership_lost')
  } })
  yield* check
  // Mint only after the actual writer and database file have been acquired.
  // A new acquisition receives a new incarnation; capture/environment IDs stay original.
  const owner = SessionStateOwner.of({ runtimeGeneration: randomUUID(), assertCurrent: check })
  const watch = Effect.forever(Effect.sleep('1 second').pipe(Effect.andThen(check)))
  // The nested scope closes SQL and all runtime consumers before releasing the writer.
  return yield* Effect.raceFirst(Effect.scoped(use.pipe(
    Effect.provideService(SessionStateOwner, owner), Effect.provide(sql),
  )), watch)
}))
