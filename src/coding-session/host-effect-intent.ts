import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createJsonExclusive, ensurePrivateDir, writeJsonAtomic, type CodingSessionPaths } from './session-files.js'
import { SessionEffectRefused, type SessionEffectAuthority } from './session-effect-authority.js'
import type { CodingSessionRequest } from './types.js'

/** A process death anywhere after this claim leaves an uncertain effect, never an instruction to replay it. */
export const claimHostEffect = async (
  paths: CodingSessionPaths, request: CodingSessionRequest, effect: SessionEffectAuthority,
): Promise<string> => {
  if ('kind' in effect.scope) throw new SessionEffectRefused()
  const directory = join(paths.dir, 'effect-intents')
  await ensurePrivateDir(directory)
  const path = join(directory, `${request.id}.json`)
  const record = { phase: 'attempting', requestId: request.id,
    digest: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    originalAuthority: effect.scope, at: new Date().toISOString() }
  if (!await createJsonExclusive(path, record, effect)) throw new SessionEffectRefused()
  return path
}

/** Queue acceptance is not provider completion. The retained record deliberately says only what is known. */
export const recordHostEffectAccepted = async (path: string, requestId: string): Promise<void> => {
  await writeJsonAtomic(`${path}.outcome`, { requestId, phase: 'accepted_by_driver', at: new Date().toISOString() })
}
