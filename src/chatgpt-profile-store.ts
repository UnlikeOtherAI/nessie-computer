import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PersonalChatgptConnectIntentSchema, type PersonalChatgptConnectIntent } from '@nessie/executor-protocol'
import { ChatgptProfileRecordSchema, type ChatgptProfileRecord } from './chatgpt-profile-records.js'
import { acquireOwnerStateLock, type PersonalAdmissionLockOptions } from './personal-admission-lock.js'
import { personalInferenceDirectory, PersonalInferenceProtectionError } from './personal-inference-paths.js'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory, type StateSecurityDeps } from './state-security.js'
import { replaceOwnerOnlyJson } from './owner-only-json.js'

const ProfileId = z.string().uuid()
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
export const chatgptBytesDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Public local metadata only. Reading this store never reads a credential file. */
export class ChatgptProfileStore {
  readonly directory: string
  constructor(readonly options: {
    directory?: string; security?: StateSecurityDeps; lock?: PersonalAdmissionLockOptions
  } = {}) { this.directory = options.directory ?? personalInferenceDirectory() }

  profileDirectory(profileId: string): string { return join(this.directory, 'profiles', ProfileId.parse(profileId)) }
  private metadataPath(profileId: string): string { return join(this.profileDirectory(profileId), 'profile.json') }

  async read(profileId: string): Promise<ChatgptProfileRecord | null> {
    try {
      await assertOwnerOnlyStatePath(this.directory, 'directory', this.options.security)
      await assertOwnerOnlyStatePath(join(this.directory, 'profiles'), 'directory', this.options.security)
      await assertOwnerOnlyStatePath(this.profileDirectory(profileId), 'directory', this.options.security)
      const path = this.metadataPath(profileId)
      await assertOwnerOnlyStatePath(path, 'file', this.options.security)
      const bytes = await readFile(path)
      if (bytes.length > 128 * 1024) throw new PersonalInferenceProtectionError('chatgpt_profile_invalid')
      const record = ChatgptProfileRecordSchema.parse(JSON.parse(bytes.toString('utf8')))
      if (record.profileId !== profileId) throw new PersonalInferenceProtectionError('chatgpt_profile_invalid')
      return record
    } catch (error) { if (missing(error)) return null; throw error }
  }

  async scoped(intentInput: PersonalChatgptConnectIntent): Promise<ChatgptProfileRecord[]> {
    const intent = PersonalChatgptConnectIntentSchema.parse(intentInput)
    return (await this.connection(intent.apiOrigin, intent.executorId)).filter(record =>
      record.organizationId === intent.organizationId && record.teamId === intent.teamId
      && (!intent.profileId || record.profileId === intent.profileId))
  }

  async connection(apiOrigin: string, executorId: string): Promise<ChatgptProfileRecord[]> {
    let names: string[]
    try {
      await assertOwnerOnlyStatePath(join(this.directory, 'profiles'), 'directory', this.options.security)
      names = await readdir(join(this.directory, 'profiles'))
    } catch (error) { if (missing(error)) return []; throw error }
    if (names.length > 256) throw new PersonalInferenceProtectionError('chatgpt_profile_invalid')
    const profiles: ChatgptProfileRecord[] = []
    for (const name of names) {
      if (!ProfileId.safeParse(name).success) throw new PersonalInferenceProtectionError('chatgpt_profile_invalid')
      const record = await this.read(name)
      if (record && record.apiOrigin === apiOrigin && record.executorId === executorId) profiles.push(record)
    }
    return profiles
  }

  async update(profileId: string, change: (previous: ChatgptProfileRecord | null) => ChatgptProfileRecord):
  Promise<ChatgptProfileRecord> {
    await ensureOwnerOnlyStateDirectory(this.directory, this.options.security)
    await ensureOwnerOnlyStateDirectory(join(this.directory, 'profiles'), this.options.security)
    const directory = this.profileDirectory(profileId)
    await ensureOwnerOnlyStateDirectory(directory, this.options.security)
    const lock = await acquireOwnerStateLock(directory, 'mutation.lock', {
      ...this.options.lock, security: this.options.security,
    })
    try {
      const prior = await this.read(profileId)
      const next = ChatgptProfileRecordSchema.parse(change(prior))
      if (next.profileId !== profileId || next.revision !== (prior?.revision ?? -1) + 1) {
        throw new PersonalInferenceProtectionError('chatgpt_profile_fenced')
      }
      await replaceOwnerOnlyJson(this.metadataPath(profileId), next, this.options.security)
      return next
    } finally { await lock.release() }
  }

  async operation(operationId: string): Promise<ChatgptProfileRecord | null> {
    ProfileId.parse(operationId)
    let names: string[]
    try {
      await assertOwnerOnlyStatePath(this.directory, 'directory', this.options.security)
      await assertOwnerOnlyStatePath(join(this.directory, 'profiles'), 'directory', this.options.security)
      names = await readdir(join(this.directory, 'profiles'))
    }
    catch (error) { if (missing(error)) return null; throw error }
    if (names.length > 256) throw new PersonalInferenceProtectionError('chatgpt_profile_invalid')
    for (const name of names) {
      const record = await this.read(ProfileId.parse(name))
      if (record?.operationId === operationId) return record
    }
    return null
  }

  async hostId(): Promise<string> {
    await ensureOwnerOnlyStateDirectory(this.directory, this.options.security)
    const lock = await acquireOwnerStateLock(this.directory, 'mutation.lock', {
      ...this.options.lock, security: this.options.security,
    })
    try {
      const path = join(this.directory, 'chatgpt-host.json')
      const exists = await lstat(path).catch((error: unknown) => { if (missing(error)) return null; throw error })
      if (exists) {
        await assertOwnerOnlyStatePath(path, 'file', this.options.security)
        const value = z.object({ version: z.literal(1), id: ProfileId }).strict().parse(
          JSON.parse(await readFile(path, 'utf8')))
        return value.id
      }
      const id = randomUUID()
      await replaceOwnerOnlyJson(path, { version: 1, id }, this.options.security)
      return id
    } finally { await lock.release() }
  }
}
