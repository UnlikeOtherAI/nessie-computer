import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ChatgptSigningKeySchema } from './chatgpt-profile-records.js'
import { ChatgptProfileStore } from './chatgpt-profile-store.js'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory } from './state-security.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'
import { acquireOwnerStateLock } from './personal-admission-lock.js'
import type { PersonalStateMutation } from './personal-state-mutation.js'

const KeySchema = ChatgptSigningKeySchema.extend({ receiptKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict()
export type ChatgptProfileKey = z.infer<typeof KeySchema>
export const newChatgptProfileKey = (profileId: string): ChatgptProfileKey => {
  const key = generateKeyPairSync('ed25519')
  return KeySchema.parse({ format: 1, profileId,
    publicKey: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    privateKey: key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    receiptKey: randomBytes(32).toString('base64url') })
}
export const saveNewChatgptProfileKey = async (
  key: ChatgptProfileKey, mutation: PersonalStateMutation,
): Promise<void> => {
  key = KeySchema.parse(key)
  const directory = new ChatgptProfileStore().profileDirectory(key.profileId)
  await ensureOwnerOnlyStateDirectory(directory)
  const lock = await acquireOwnerStateLock(directory, 'mutation.lock')
  try {
    const path = join(directory, 'companion-key.json')
    try { await readFile(path); throw new PersonalInferenceProtectionError('chatgpt_profile_key_exists') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await mutation.mutate(path, { operation: 'replace', expectedDigest: null,
      bytes: Buffer.from(`${JSON.stringify(key)}\n`) })
  } finally { await lock.release() }
}
export const readChatgptProfileKey = async (profileId: string): Promise<ChatgptProfileKey> => {
  const directory = new ChatgptProfileStore().profileDirectory(profileId)
  await assertOwnerOnlyStatePath(directory, 'directory')
  const path = join(directory, 'companion-key.json')
  await assertOwnerOnlyStatePath(path, 'file')
  const bytes = await readFile(path)
  if (bytes.length > 16 * 1024) throw new PersonalInferenceProtectionError('chatgpt_profile_key_invalid')
  const key = KeySchema.parse(JSON.parse(bytes.toString('utf8')))
  if (key.profileId !== profileId) throw new PersonalInferenceProtectionError('chatgpt_profile_key_invalid')
  return key
}
