import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { applySessionEngineBoundaryPatches } from '../../../packaging/session-engine/patches.mjs'

export const clientConnectionManifestBytes = readFileSync(new URL('./boundary-patches.json', import.meta.url))
export const webConnectionManifestBytes = readFileSync(new URL('./web-boundary-patches.json', import.meta.url))
export const registryConnectionManifestBytes = readFileSync(new URL('./registry-patches.json', import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** Build inputs only. No source execution, app startup, account adapter or runtime authority. */
export const T3_CLIENT_CONNECTION_PATCHES = Object.freeze({
  sourceCommit: JSON.parse(clientConnectionManifestBytes).sourceCommit,
  capsuleManifestSha256: digest(clientConnectionManifestBytes),
  webManifestSha256: digest(webConnectionManifestBytes),
  registryManifestSha256: digest(registryConnectionManifestBytes),
})

/** Apply through C02's ordered full-file hash and unique-seam verifier. */
export const applyClientConnectionPatches = snapshot =>
  applySessionEngineBoundaryPatches(snapshot, clientConnectionManifestBytes)

/** The caller supplies separately verified committed web source, which is absent from the capsule. */
export const applyWebConnectionPatches = snapshot =>
  applySessionEngineBoundaryPatches(snapshot, webConnectionManifestBytes)

/** Independent original registry lifecycle repair, composed after the URL family by its owner. */
export const applyRegistryConnectionPatches = snapshot =>
  applySessionEngineBoundaryPatches(snapshot, registryConnectionManifestBytes)
