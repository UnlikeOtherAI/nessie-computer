import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { link, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { CloudCapacityMutation } from './cloud-capacity-state.js'
import { assertOwnerOnlyStatePath, secureOwnerOnlyStateFile, type StateSecurityDeps } from './state-security.js'

/** Atomic shared key publication: another process never observes an empty key file. */
export const openInferenceResourceIdentity = async (
  directory: string, security: StateSecurityDeps,
  cloud?: { mutate: CloudCapacityMutation; barrier: (directory: string) => Promise<void> },
): Promise<{ privateKey: string; publicKey: string }> => {
  const path = join(directory, 'resource-key.json')
  if (cloud) {
    try { await readFile(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const keys = generateKeyPairSync('ed25519')
      const bytes = Buffer.from(JSON.stringify({
        privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
        publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      }))
      await cloud.mutate(path, { operation: 'replace', bytes, expectedDigest: null })
    }
    await cloud.barrier(directory)
  } else {
    const temporary = `${path}.${randomUUID()}.new`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        const keys = generateKeyPairSync('ed25519')
        await file.writeFile(JSON.stringify({
          privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
          publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
        }))
        await file.sync()
      } finally { await file.close() }
      await secureOwnerOnlyStateFile(temporary, security)
      await link(temporary, path)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    finally { await unlink(temporary).catch(() => undefined) }
  }
  await assertOwnerOnlyStatePath(path, 'file', security)
  const identity = JSON.parse(await readFile(path, 'utf8')) as { privateKey: string; publicKey: string }
  if (typeof identity.privateKey !== 'string' || typeof identity.publicKey !== 'string') {
    throw new Error('Local inference resource identity needs repair.')
  }
  const privateKey = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64url'),
    format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey(privateKey)
  if (privateKey.asymmetricKeyType !== 'ed25519'
    || publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') !== identity.publicKey) {
    throw new Error('Local inference resource identity needs repair.')
  }
  return identity
}
