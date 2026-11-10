import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ChatgptTokenRecordSchema, type ChatgptTokenRecord } from './chatgpt-profile-records.js'
import { chatgptBytesDigest } from './chatgpt-profile-store.js'
import { acquireOwnerStateLock, type PersonalAdmissionLockOptions } from './personal-admission-lock.js'
import type { PersonalStateMutation } from './personal-state-mutation.js'
import { assertOwnerOnlyStatePath, type StateSecurityDeps } from './state-security.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'
import type { ChatgptTokens } from './chatgpt-oauth-provider.js'

/** Constructed only inside a registered credential process after native custody admission. */
export type ChatgptCredentialAuthority = {
  assertCurrent: (purpose?: 'grant' | 'clear') => Promise<void>
}
const invalid: () => never = () => { throw new PersonalInferenceProtectionError('chatgpt_credential_fenced') }
const bytes = (record: ChatgptTokenRecord): Buffer => Buffer.from(`${JSON.stringify(record)}\n`)
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

export class ChatgptCredentialStore {
  readonly directory: string
  private readonly path: string
  constructor(private readonly input: {
    profileId: string; accountGeneration: number; consentRevision: number
    mutation: PersonalStateMutation; authority: ChatgptCredentialAuthority
    security?: StateSecurityDeps; lock?: PersonalAdmissionLockOptions
  }) {
    const profileId = z.string().uuid().parse(input.profileId)
    if (!Number.isSafeInteger(input.accountGeneration) || input.accountGeneration < 1
      || !Number.isSafeInteger(input.consentRevision) || input.consentRevision < 1) invalid()
    this.directory = join(input.mutation.root, 'profiles', profileId)
    this.path = join(this.directory, 'credentials.json')
  }

  private async read(purpose: 'grant' | 'clear'): Promise<{ record: ChatgptTokenRecord; digest: string } | null> {
    await this.input.authority.assertCurrent(purpose)
    try {
      await assertOwnerOnlyStatePath(this.path, 'file', this.input.security)
      const value = await readFile(this.path)
      if (value.length > 512 * 1024) invalid()
      const record = ChatgptTokenRecordSchema.parse(JSON.parse(value.toString('utf8')))
      if (record.profileId !== this.input.profileId || record.accountGeneration !== this.input.accountGeneration
        || record.consentRevision !== this.input.consentRevision) invalid()
      return { record, digest: chatgptBytesDigest(value) }
    } catch (error) { if (missing(error)) return null; throw error }
  }

  private async locked<T>(purpose: 'grant' | 'clear', work: () => Promise<T>): Promise<T> {
    await this.input.authority.assertCurrent(purpose)
    await this.input.mutation.ensureDirectory(this.directory)
    const lock = await acquireOwnerStateLock(this.directory, 'credential.lock', {
      ...this.input.lock, security: this.input.security,
    })
    try { return await work() } finally { await lock.release() }
  }

  /** A sign-in never silently overwrites another account/generation's live bytes. */
  save(tokens: ChatgptTokens): Promise<void> {
    return this.locked('grant', async () => {
      const prior = await this.read('grant')
      if (prior !== null) invalid()
      const record = ChatgptTokenRecordSchema.parse({ format: 1, profileId: this.input.profileId,
        accountGeneration: this.input.accountGeneration, consentRevision: this.input.consentRevision,
        revision: 1, rotationId: null, tokens })
      await this.input.authority.assertCurrent('grant')
      await this.input.mutation.mutate(this.path, { operation: 'replace', expectedDigest: null, bytes: bytes(record) })
    })
  }

  /** Only this credential process receives token objects; status reads public metadata. */
  load(): Promise<ChatgptTokens> {
    return this.locked('grant', async () => {
      const value = await this.read('grant')
      if (!value?.record.tokens || value.record.rotationId !== null) invalid()
      return value.record.tokens
    })
  }

  /** Explicit fresh sign-in may retire a spent marker, never recover its predecessor grant. */
  clearSpent(): Promise<boolean> {
    return this.locked('grant', async () => {
      const prior = await this.read('grant')
      if (!prior || prior.record.rotationId === null || prior.record.tokens !== null) return false
      await this.input.authority.assertCurrent('grant')
      await this.input.mutation.mutate(this.path, { operation: 'delete', expectedDigest: prior.digest })
      await this.input.mutation.barrier(this.directory)
      return true
    })
  }

  /** Persist nonretryability before POST; only an exact successful CAS publishes replacements. */
  refresh(exchange: (previous: ChatgptTokens) => Promise<ChatgptTokens>): Promise<ChatgptTokens> {
    return this.locked('grant', async () => {
      const prior = await this.read('grant')
      if (!prior?.record.tokens || !prior.record.tokens.refreshToken || prior.record.rotationId !== null) invalid()
      const spent: ChatgptTokenRecord = { ...prior.record, revision: prior.record.revision + 1,
        rotationId: randomUUID(), tokens: null }
      const spentBytes = bytes(spent)
      await this.input.authority.assertCurrent('grant')
      await this.input.mutation.mutate(this.path, {
        operation: 'replace', expectedDigest: prior.digest, bytes: spentBytes,
      })
      // No catch restores prior bytes or retries an ambiguous rotating grant.
      const replacement = await exchange(prior.record.tokens)
      if (!replacement.accessToken || !replacement.refreshToken
        || replacement.issuer !== prior.record.tokens.issuer || replacement.subject !== prior.record.tokens.subject
        || replacement.accountId !== prior.record.tokens.accountId) {
        invalid()
      }
      const next = ChatgptTokenRecordSchema.parse({ ...spent, revision: spent.revision + 1,
        rotationId: null, tokens: replacement })
      await this.input.authority.assertCurrent('grant')
      await this.input.mutation.mutate(this.path, {
        operation: 'replace', expectedDigest: chatgptBytesDigest(spentBytes), bytes: bytes(next),
      })
      return next.tokens!
    })
  }

  /** Runs in a registered short-lived credential child, never the final public controller. */
  clear(revoke: (tokens: ChatgptTokens) => Promise<boolean>): Promise<{ remoteRevoked: boolean | null }> {
    return this.locked('clear', async () => {
      const prior = await this.read('clear')
      let remoteRevoked: boolean | null = null
      if (prior?.record.tokens) {
        try { remoteRevoked = await revoke(prior.record.tokens) } catch { remoteRevoked = false }
      }
      await this.input.authority.assertCurrent('clear')
      if (prior) await this.input.mutation.mutate(this.path, { operation: 'delete', expectedDigest: prior.digest })
      await this.input.mutation.barrier(this.directory)
      return { remoteRevoked }
    })
  }
}
