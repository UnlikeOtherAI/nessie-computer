import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  prepareSessionEngineSource, T3_SESSION_ENGINE_SOURCE, verifySessionEngineSource,
} from '../../packaging/session-engine/source.mjs'
import { readSessionEngineSnapshot } from '../../packaging/session-engine/snapshot.mjs'

const execute = promisify(execFile)
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const scratch = fileURLToPath(new URL('../../.artifacts/t19-client-connection/', import.meta.url))
export const webTargetPath = 'apps/web/src/environments/primary/target.ts'

/** Only committed Git objects may supplement the capsule's intentionally omitted apps. */
export const readCommittedFile = async (repository, path) => {
  const result = await execute('git', [
    '--no-replace-objects', '-C', resolve(repository), 'show', `${T3_SESSION_ENGINE_SOURCE.commit}:${path}`,
  ], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 10_000 })
  return result.stdout
}

export const readOriginalSnapshot = async () => {
  const repository = process.env.T3_CLIENT_CONNECTION_SOURCE_REPOSITORY
  const archivePath = process.env.T3_CLIENT_CONNECTION_SOURCE_ARCHIVE ?? resolve(scratch, 'source.tar')
  if (repository) await prepareSessionEngineSource({ sourceRepository: repository, archivePath })
  return readSessionEngineSnapshot(archivePath)
}

export const readWebSnapshot = async expectedHash => {
  const repository = process.env.T3_CLIENT_CONNECTION_SOURCE_REPOSITORY
  if (!repository) throw new Error('T3_CLIENT_CONNECTION_SOURCE_REPOSITORY is required for the web boundary check')
  await verifySessionEngineSource(repository)
  const bytes = await readCommittedFile(repository, webTargetPath)
  if (expectedHash !== undefined && sha256(bytes) !== expectedHash) throw new Error('WEB_SOURCE_HASH_MISMATCH')
  // This is a separately verified Git input, never represented as a capsule member.
  return Object.freeze({
    identity: Object.freeze({ commit: T3_SESSION_ENGINE_SOURCE.commit, tree: T3_SESSION_ENGINE_SOURCE.tree }),
    files: Object.freeze([webTargetPath]),
    read: path => {
      if (path !== webTargetPath) throw new Error('WEB_SOURCE_PATH_REFUSED')
      return Buffer.from(bytes)
    },
  })
}
