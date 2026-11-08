import { readFileSync } from 'node:fs'
import { applySessionEngineBoundaryPatches, composeSessionEnginePatchManifests } from './patches.mjs'

const families = [
  ['state', './boundary-patches.json'],
  ['client-connection', '../../patches/t3-session/client-connection/boundary-patches.json'],
  ['extraction', '../../patches/t3-session/extraction/boundary-patches.json'],
]

/** Compose once from original bytes. Sequential applications cannot replace the provenance digest. */
export const prepareSessionEngineSnapshot = (snapshot, {
  additionalPatchFamilies = [], includeSessionControl = true,
} = {}) => {
  const selected = families.map(([id, file]) => ({
    id, bytes: readFileSync(new URL(file, import.meta.url)),
  }))
  if (includeSessionControl) selected.push({ id: 'session-control',
    bytes: readFileSync(new URL('../../patches/t3-session/session-control/boundary-patches.json', import.meta.url)) })
  // Additional committed families must already bind this exact ordered source version.
  const manifestBytes = composeSessionEnginePatchManifests(snapshot, [...selected, ...additionalPatchFamilies])
  return { snapshot: applySessionEngineBoundaryPatches(snapshot, manifestBytes), manifestBytes }
}
