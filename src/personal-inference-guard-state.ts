import { open } from 'node:fs/promises'
import { ExecutorInferenceSourceSchema, PersonalInferencePrincipalSchema,
  samePersonalInferenceCustodian } from '@nessie/executor-protocol'

import type { CodingProcessIdentity } from './coding-session/types.js'
import type { PersonalInferenceGuardState, PersonalInferenceProtection } from './personal-inference-guard.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'

const MAX_BYTES = 1024 * 1024
const MAX_REGISTRATIONS = 4096
// Recovery is bounded too. These are read-only ceilings, never write limits.
const RECOVERY_BYTES = 8 * MAX_BYTES
const RECOVERY_REGISTRATIONS = 8 * MAX_REGISTRATIONS
const invalid = (): never => { throw new PersonalInferenceProtectionError('personal_inference_guard_invalid') }

export const validProtection = (profile: PersonalInferenceProtection): boolean => !!profile
  && typeof profile.profileId === 'string' && profile.profileId.length > 0 && profile.profileId.length <= 200
  && PersonalInferencePrincipalSchema.safeParse(profile.principal).success
  && (profile.backgroundConsentRevision === null || Number.isSafeInteger(profile.backgroundConsentRevision)
    && profile.backgroundConsentRevision > 0)
  && (profile.inferenceSource === undefined ? profile.backgroundConsentRevision === null
    : ExecutorInferenceSourceSchema.options[1].safeParse(profile.inferenceSource).success
      && profile.inferenceSource.profileId === profile.profileId)

export const validExecutionIdentity = (identity: CodingProcessIdentity): boolean => !!identity
  && Number.isSafeInteger(identity.pid) && identity.pid > 0
  && (identity.startedAt === undefined || typeof identity.startedAt === 'string' && /^\d+$/u.test(identity.startedAt))
  && (identity.containment === undefined || ['windows_job', 'posix_group'].includes(identity.containment))

const validate = (state: PersonalInferenceGuardState, registrationLimit: number): void => {
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.registrations) || state.registrations.length > registrationLimit
    || state.protection !== null && (!state.protection || !Array.isArray(state.protection.profiles)
      || state.protection.profiles.length === 0 || state.protection.profiles.length > 256
      || state.protection.profiles.some(profile => !validProtection(profile))
      || new Set(state.protection.profiles.map(profile => profile.profileId)).size !== state.protection.profiles.length
      || state.protection.profiles.some(profile => !samePersonalInferenceCustodian(
        profile.principal, state.protection!.profiles[0]!.principal)))) return invalid()
  const ids = new Set<string>()
  for (const item of state.registrations) {
    if (!item || typeof item.id !== 'string' || ids.has(item.id) || !Number.isSafeInteger(item.pid) || item.pid < 1
      || typeof item.startedAt !== 'string' || !item.startedAt || typeof item.label !== 'string'
      || !['runtime', 'host_execution', 'credential_runtime'].includes(item.kind)
      || !Number.isSafeInteger(item.guardVersion)
      || item.bootId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(item.bootId)
      || item.authority !== null && typeof item.authority !== 'object'
      || item.execution !== undefined && (!item.execution || !validExecutionIdentity(item.execution.identity)
        || !Array.isArray(item.execution.descendants) || item.execution.descendants.length > 4096
        || !item.execution.descendants.every(validExecutionIdentity))) return invalid()
    ids.add(item.id)
  }
}

const serialize = (state: PersonalInferenceGuardState): string => `${JSON.stringify(state)}\n`

export const guardWithinCapacity = (state: PersonalInferenceGuardState): boolean =>
  state.registrations.length <= MAX_REGISTRATIONS && Buffer.byteLength(serialize(state), 'utf8') <= MAX_BYTES

/** Validate the exact bytes that will be published, before any credential callback. */
export const encodeGuardState = (state: PersonalInferenceGuardState): string => {
  validate(state, MAX_REGISTRATIONS)
  const text = serialize(state)
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return invalid()
  return text
}

/** The caller validates ownership; an oversized file is read only under the admission lock. */
export const readGuardState = async (path: string, recovery: boolean): Promise<PersonalInferenceGuardState> => {
  const limit = recovery ? RECOVERY_BYTES : MAX_BYTES
  const handle = await open(path, 'r')
  let bytes: Buffer
  try {
    if ((await handle.stat()).size > limit) return invalid()
    // Bound memory and reads even if a cooperative file changes after stat.
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > limit) return invalid()
    bytes = buffer.subarray(0, length)
  } finally { await handle.close() }
  let state: PersonalInferenceGuardState
  try { state = JSON.parse(bytes.toString('utf8')) as PersonalInferenceGuardState }
  catch { return invalid() }
  validate(state, recovery ? RECOVERY_REGISTRATIONS : MAX_REGISTRATIONS)
  return state
}
