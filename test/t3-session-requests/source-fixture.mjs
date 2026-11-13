import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

import { prepareSessionEngineSource } from '../../packaging/session-engine/source.mjs'
import { readSessionEngineSnapshot } from '../../packaging/session-engine/snapshot.mjs'
import { prepareSessionEngineSnapshot } from '../../packaging/session-engine/engine-snapshot.mjs'
import { requestPrivacyManifestBytes } from '../../patches/t3-session/requests/index.mjs'

export const scratch = fileURLToPath(new URL('../../.artifacts/c05-requests/', import.meta.url))
const loadRequestSource = async () => {
  const archivePath = process.env.T3_REQUEST_PRIVACY_SOURCE_ARCHIVE ?? resolve(scratch, 'source.tar')
  const repository = process.env.T3_REQUEST_PRIVACY_SOURCE_REPOSITORY
  if (repository) await prepareSessionEngineSource({ sourceRepository: repository, archivePath })
  const original = await readSessionEngineSnapshot(archivePath)
  const { snapshot: prefix } = prepareSessionEngineSnapshot(original)
  const { snapshot, manifestBytes } = prepareSessionEngineSnapshot(original, {
    additionalPatchFamilies: [{ id: 'request-privacy', bytes: requestPrivacyManifestBytes }],
  })
  const file = 'packages/shared/src/t3McpToolPresentation.ts'
  const source = stripTypeScriptTypes(snapshot.read(file).toString(), { sourceUrl: file })
  const privacy = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  return { original, prefix, snapshot, privacy, manifestBytes }
}
let source
export const readRequestSource = () => source ??= loadRequestSource()
