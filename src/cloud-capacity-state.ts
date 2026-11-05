import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { secureOwnerOnlyStateFile, type StateSecurityDeps } from './state-security.js'

/** Same CAS shape as the native personal-state consumer; bytes never cross a service pipe. */
export type CloudCapacityMutation = (path: string, input:
  | { operation: 'replace'; bytes: Buffer; expectedDigest: string | null }
  | { operation: 'delete'; expectedDigest: string },
) => Promise<void>

export const cloudCapacityDigest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
export const cloudCapacityFileDigest = async (path: string): Promise<string | null> => {
  try { return cloudCapacityDigest(await readFile(path)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

export const syncCloudCapacityDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** POSIX file + directory durability. Windows requires the verified native consumer. */
export const posixCloudCapacityMutation = (
  security: StateSecurityDeps,
): CloudCapacityMutation => async (path, input) => {
  if (process.platform === 'win32') throw new Error('Cloud capacity requires the verified native state consumer.')
  if (await cloudCapacityFileDigest(path) !== input.expectedDigest) throw new Error('Cloud state mutation was fenced.')
  if (input.operation === 'delete') {
    await unlink(path)
    await syncCloudCapacityDirectory(dirname(path))
    return
  }
  const draft = `${path}.${randomUUID()}.new`
  const handle = await open(draft, 'wx', 0o600)
  try { await handle.writeFile(input.bytes); await handle.sync() } finally { await handle.close() }
  try {
    await secureOwnerOnlyStateFile(draft, security)
    await rename(draft, path)
    await syncCloudCapacityDirectory(dirname(path))
  } finally { await unlink(draft).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }) }
}
