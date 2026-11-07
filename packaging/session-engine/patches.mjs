import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { SessionEngineSourceError } from './source.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const defaultBytes = readFileSync(new URL('./boundary-patches.json', import.meta.url))

/** Small reviewed source-boundary edits; original capsule bytes remain unchanged. */
export const applySessionEngineBoundaryPatches = (snapshot, manifestBytes = defaultBytes) => {
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.format !== 1 || manifest.sourceCommit !== snapshot.identity.commit || !Array.isArray(manifest.patches)) {
    throw new SessionEngineSourceError('SESSION_ENGINE_BOUNDARY_PATCH_MANIFEST_REFUSED')
  }
  const modified = new Map()
  for (const patch of manifest.patches) {
    const before = modified.get(patch.file) ?? snapshot.read(patch.file)
    if (hash(before) !== patch.beforeSha256 || typeof patch.from !== 'string' || patch.from === ''
      || typeof patch.to !== 'string' || before.toString('utf8').split(patch.from).length !== 2) {
      throw new SessionEngineSourceError('SESSION_ENGINE_BOUNDARY_PATCH_SOURCE_MISMATCH')
    }
    const after = Buffer.from(before.toString('utf8').replace(patch.from, patch.to))
    if (hash(after) !== patch.afterSha256) throw new SessionEngineSourceError('SESSION_ENGINE_BOUNDARY_PATCH_RESULT_MISMATCH')
    modified.set(patch.file, after)
  }
  return Object.freeze({
    files: snapshot.files,
    identity: Object.freeze({ ...snapshot.identity, orderedPatchesSha256: hash(manifestBytes) }),
    read: file => modified.has(file) ? Buffer.from(modified.get(file)) : snapshot.read(file),
  })
}
