import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Outbox, Sqlite } from '@nessie/t3-session-source/engine'

/** Actual original SQLite/outbox, with retained external test state. Synthetic
 * authority services in callers supply ordering evidence, never native grants. */
export const withOriginalOutbox = async program => {
  const parent = resolve(process.env.T3_RUNTIME_FIXTURE_ROOT ?? join(tmpdir(), 'nessie-session-claim-tests'))
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'claims-'))
  const sql = Sqlite.layerFromPath(join(directory, 'claims.sqlite')).pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
  const services = Outbox.layer.pipe(Layer.provideMerge(sql))
  return Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(services))))
}
