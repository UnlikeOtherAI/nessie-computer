import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { applySessionEngineBoundaryPatches } from '../../../packaging/session-engine/patches.mjs'

export const requestPrivacyManifestBytes = readFileSync(new URL('./boundary-patches.json', import.meta.url))
export const T3_REQUEST_PRIVACY_PATCHES = Object.freeze({
  sourceCommit: JSON.parse(requestPrivacyManifestBytes).sourceCommit,
  manifestSha256: createHash('sha256').update(requestPrivacyManifestBytes).digest('hex'),
})

/** Build input only; T02 must combine all families before applying once and recording the digest. */
export const applyRequestPrivacyPatches = snapshot =>
  applySessionEngineBoundaryPatches(snapshot, requestPrivacyManifestBytes)
