import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { SessionEngineSourceError } from './source.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const defaultBytes = readFileSync(new URL('./boundary-patches.json', import.meta.url))

/** One ordered digest for all selected families, before any patch is applied. */
export const composeSessionEnginePatchManifests = (snapshot, families) => {
  if (!Array.isArray(families) || families.length === 0 || snapshot.identity.orderedPatchesSha256) {
    throw new SessionEngineSourceError('SESSION_ENGINE_BOUNDARY_PATCH_COMPOSITION_REFUSED')
  }
  const ids = new Set()
  const manifests = families.map(({ id, bytes }) => {
    const manifest = JSON.parse(bytes.toString('utf8'))
    if (typeof id !== 'string' || !id || ids.has(id) || manifest.format !== 1
      || manifest.sourceCommit !== snapshot.identity.commit || !Array.isArray(manifest.patches)) {
      throw new SessionEngineSourceError('SESSION_ENGINE_BOUNDARY_PATCH_MANIFEST_REFUSED')
    }
    ids.add(id)
    return { id, sha256: hash(bytes), patches: manifest.patches }
  })
  return Buffer.from(JSON.stringify({ format: 1, sourceCommit: snapshot.identity.commit,
    families: manifests.map(({ id, sha256 }) => ({ id, sha256 })),
    patches: manifests.flatMap(({ patches }) => patches),
  }))
}

/** Small reviewed source-boundary edits; original capsule bytes remain unchanged. */
export const applySessionEngineBoundaryPatches = (snapshot, manifestBytes = defaultBytes) => {
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.format !== 1 || manifest.sourceCommit !== snapshot.identity.commit || !Array.isArray(manifest.patches)) {
    throw new SessionEngineSourceError('SESSION_ENGINE_BOUNDARY_PATCH_MANIFEST_REFUSED')
  }
  const modified = new Map()
  for (const patch of manifest.patches) {
    if (patch.create) {
      if (patch.beforeSha256 !== null || snapshot.files.includes(patch.file) || modified.has(patch.file)
        || !/^apps\/server\/src\/[\w/.-]+\.ts$/u.test(patch.file) || patch.file.includes('..')
        || !Array.isArray(patch.create)) {
        throw new SessionEngineSourceError('SESSION_ENGINE_BOUNDARY_PATCH_CREATE_REFUSED')
      }
      const after = Buffer.concat(patch.create.map(part => {
        if (typeof part.text === 'string' && Object.keys(part).length === 1) return Buffer.from(part.text)
        if (part.sourceStage !== undefined && part.sourceStage !== 'current') {
          throw new SessionEngineSourceError('SESSION_ENGINE_BOUNDARY_PATCH_SOURCE_MISMATCH')
        }
        const original = part.sourceStage === 'current'
          ? modified.get(part.sourceFile) ?? snapshot.read(part.sourceFile) : snapshot.read(part.sourceFile)
        if (part.sourceStage === 'current' && hash(original) !== part.sourceSha256) {
          throw new SessionEngineSourceError('SESSION_ENGINE_BOUNDARY_PATCH_SOURCE_MISMATCH')
        }
        if (!Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.end)
          || part.start < 0 || part.end <= part.start || part.end > original.length) {
          throw new SessionEngineSourceError('SESSION_ENGINE_BOUNDARY_PATCH_SOURCE_MISMATCH')
        }
        const selected = original.subarray(part.start, part.end)
        if (hash(selected) !== part.sha256) throw new SessionEngineSourceError('SESSION_ENGINE_BOUNDARY_PATCH_SOURCE_MISMATCH')
        return selected
      }))
      if (hash(after) !== patch.afterSha256) throw new SessionEngineSourceError('SESSION_ENGINE_BOUNDARY_PATCH_RESULT_MISMATCH')
      modified.set(patch.file, after)
      continue
    }
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
    files: Object.freeze([...new Set([...snapshot.files, ...modified.keys()])].sort()),
    identity: Object.freeze({ ...snapshot.identity, orderedPatchesSha256: hash(manifestBytes) }),
    read: file => modified.has(file) ? Buffer.from(modified.get(file)) : snapshot.read(file),
  })
}
