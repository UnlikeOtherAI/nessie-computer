import { randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  PERSONAL_INFERENCE_GUARD_VERSION, PersonalInferenceAuthoritySchema, PersonalInferencePrincipalSchema,
  ExecutorInferenceSourceSchema, canonicalExecutorJson, sameExecutorInferenceSource, samePersonalInferenceCustodian,
  type ExecutorInferenceSource, type PersonalInferenceAuthority, type PersonalInferencePrincipal,
} from '@nessie/executor-protocol'

import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { acquirePersonalAdmissionLock, createAdmissionProcessInspector,
  type PersonalAdmissionLockOptions } from './personal-admission-lock.js'
import type { CodingProcessIdentity } from './coding-session/types.js'
import { currentKernelBootId } from './kernel-boot.js'
import { PersonalNativeWriters } from './personal-native-writers.js'
import { personalInferenceDirectory, PersonalInferenceProtectionError } from './personal-inference-paths.js'
import {
  assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory, type StateSecurityDeps,
} from './state-security.js'

export type PersonalHostRegistration = {
  id: string; pid: number; startedAt: string; bootId?: string; label: string; guardVersion: number
  kind: 'runtime' | 'host_execution' | 'credential_runtime'; authority: PersonalInferenceAuthority | null
  execution?: { identity: CodingProcessIdentity; descendants: CodingProcessIdentity[] }
}
export type PersonalInferenceProtection = {
  profileId: string; principal: PersonalInferencePrincipal; backgroundConsentRevision: number | null
  inferenceSource?: Extract<ExecutorInferenceSource, { kind: 'chatgpt' }>
}
export type PersonalInferenceGuardState = {
  version: 1; revision: number; protection: { profiles: PersonalInferenceProtection[] } | null
  registrations: PersonalHostRegistration[]
}

export type PersonalHostExecutionLease = {
  id: string
  /** Persist birth evidence before the process handle can be lost. */
  bindExecution: (identity: CodingProcessIdentity, descendants?: CodingProcessIdentity[]) => Promise<void>
  /** Only after the admitted process tree is proven stopped, not on transport abort. */
  release: () => Promise<void>
  /**
   * When a stop could not be proved: the admission stays (custody), but
   * whatever process holds it open is ended, so a retried start never
   * accumulates them. Absent where nothing does.
   */
  abandon?: () => Promise<void>
}

export type PersonalInferenceGuardOptions = {
  directory?: string
  security?: StateSecurityDeps
  processIdentity?: () => Promise<{ pid: number; startedAt: string; bootId?: string }>
  kernelBootId?: () => Promise<string | undefined>
  admissionLock?: PersonalAdmissionLockOptions
  /** Must enumerate independent/live runtimes, not merely echo this guard's cooperative registry. */
  verifyRuntimeInventory?: (registered: readonly PersonalHostRegistration[]) => Promise<boolean>
}

const validProtection = (profile: PersonalInferenceProtection): boolean => !!profile
  && typeof profile.profileId === 'string' && profile.profileId.length > 0 && profile.profileId.length <= 200
  && PersonalInferencePrincipalSchema.safeParse(profile.principal).success
  && (profile.backgroundConsentRevision === null || Number.isSafeInteger(profile.backgroundConsentRevision)
    && profile.backgroundConsentRevision > 0)
  && (profile.inferenceSource === undefined ? profile.backgroundConsentRevision === null
    : ExecutorInferenceSourceSchema.options[1].safeParse(profile.inferenceSource).success
      && profile.inferenceSource.profileId === profile.profileId)

const validExecutionIdentity = (identity: CodingProcessIdentity): boolean => !!identity
  && Number.isSafeInteger(identity.pid) && identity.pid > 0
  && (identity.startedAt === undefined || typeof identity.startedAt === 'string' && /^\d+$/u.test(identity.startedAt))
  && (identity.containment === undefined || ['windows_job', 'posix_group'].includes(identity.containment))

const initial = (): PersonalInferenceGuardState => ({ version: 1, revision: 0, protection: null, registrations: [] })
const protectionError = (code: string): never => { throw new PersonalInferenceProtectionError(code) }
const ownProcessIdentity = async (): Promise<{ pid: number; startedAt: string; bootId?: string }> => {
  const identity = await createAdmissionProcessInspector().identify(process.pid)
  if (!identity?.startedAt) return protectionError('personal_inference_runtime_unverified')
  return { pid: identity.pid, startedAt: identity.startedAt, bootId: await currentKernelBootId() }
}

/**
 * Cooperative admissions under one OS account. It is never claimed as an OS sandbox.
 * Activation has no default compatibility verdict: a later auth consumer MUST prove
 * the independent runtime inventory before it can write a credential.
 */
export class PersonalInferenceGuard {
  private constructor(private readonly options: PersonalInferenceGuardOptions, readonly directory: string) {}

  static open(options: PersonalInferenceGuardOptions = {}): PersonalInferenceGuard {
    return new PersonalInferenceGuard(options, options.directory ?? personalInferenceDirectory())
  }

  private async read(): Promise<PersonalInferenceGuardState> {
    try {
      await assertOwnerOnlyStatePath(this.directory, 'directory', this.options.security)
      const path = join(this.directory, 'guard.json')
      await assertOwnerOnlyStatePath(path, 'file', this.options.security)
      const bytes = await readFile(path)
      if (bytes.length > 1024 * 1024) return protectionError('personal_inference_guard_invalid')
      let state: PersonalInferenceGuardState
      try { state = JSON.parse(bytes.toString('utf8')) as PersonalInferenceGuardState }
      catch { return protectionError('personal_inference_guard_invalid') }
      if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
        || !Array.isArray(state.registrations) || state.registrations.length > 4096
        || state.protection !== null && (!Array.isArray(state.protection.profiles)
          || state.protection.profiles.length === 0 || state.protection.profiles.length > 256
          || state.protection.profiles.some((profile) => !validProtection(profile))
          || new Set(state.protection.profiles.map((profile) => profile.profileId)).size
            !== state.protection.profiles.length
          || state.protection.profiles.some((profile) => !samePersonalInferenceCustodian(
            profile.principal, state.protection!.profiles[0]!.principal)))) {
        return protectionError('personal_inference_guard_invalid')
      }
      const ids = new Set<string>()
      for (const item of state.registrations) {
        if (!item || typeof item.id !== 'string' || ids.has(item.id) || !Number.isSafeInteger(item.pid) || item.pid < 1
          || typeof item.startedAt !== 'string' || !item.startedAt || typeof item.label !== 'string'
          || !['runtime', 'host_execution', 'credential_runtime'].includes(item.kind)
          || !Number.isSafeInteger(item.guardVersion)
          || item.bootId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(item.bootId)
          || item.authority !== null && typeof item.authority !== 'object'
          || item.execution !== undefined && (!validExecutionIdentity(item.execution.identity)
            || !Array.isArray(item.execution.descendants) || item.execution.descendants.length > 4096
            || !item.execution.descendants.every(validExecutionIdentity))) {
          return protectionError('personal_inference_guard_invalid')
        }
        ids.add(item.id)
      }
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const profiles = await lstat(join(this.directory, 'profiles')).catch((missing: unknown) => {
          if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing
          return null
        })
        if (profiles) return protectionError('personal_inference_guard_missing')
        return initial()
      }
      throw error
    }
  }

  private async mutate<T>(change: (state: PersonalInferenceGuardState) => Promise<T>): Promise<T> {
    await ensureOwnerOnlyStateDirectory(this.directory, this.options.security)
    const lock = await acquirePersonalAdmissionLock(this.directory, {
      ...this.options.admissionLock, security: this.options.security,
    })
    try {
      const state = await this.read()
      const result = await change(state)
      state.revision += 1
      await replaceOwnerOnlyJson(join(this.directory, 'guard.json'), state, this.options.security)
      return result
    } finally {
      await lock.release()
    }
  }

  /** Canonical first-use publication before any profile directory is created. */
  async initialize(): Promise<void> {
    // Publish the empty guard before first public profile metadata. Existing
    // profile directories without a guard remain corruption, never a reset.
    await this.mutate(async () => undefined)
  }

  /** Read on every operation; no stale in-process allow survives sign-in or sign-out. */
  async assertExecutionAuthority(_authority: unknown): Promise<void> {
    const { protection } = await this.read()
    if (protection) protectionError('personal_inference_host_isolation_required')
  }

  private async credentialProcessGone(item: PersonalHostRegistration): Promise<boolean> {
    if (item.bootId) {
      const boot = await (this.options.kernelBootId ?? currentKernelBootId)()
      if (!boot) return false
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(boot)) {
        return protectionError('personal_inference_runtime_unverified')
      }
      if (boot !== item.bootId) return true // Positive whole-kernel generation clearance.
    }
    const processes = this.options.admissionLock?.processes ?? createAdmissionProcessInspector()
    const current = await processes.identify(item.pid)
    return current ? current.pid === item.pid && current.startedAt !== item.startedAt : !processes.isAlive(item.pid)
  }

  /** Invoke before any credential read on restart; claims survive process failure. */
  registerCredentialRuntime(): Promise<PersonalHostExecutionLease> {
    return this.register('credential_runtime', 'personal-credential-runtime', null)
  }

  private async register(
    kind: PersonalHostRegistration['kind'], label: string, authority: unknown,
  ): Promise<PersonalHostExecutionLease> {
    const identity = await (this.options.processIdentity ?? ownProcessIdentity)()
    if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || !/^[0-9]+$/u.test(identity.startedAt)
      || identity.bootId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(identity.bootId)) {
      return protectionError('personal_inference_runtime_unverified')
    }
    const id = randomUUID()
    await this.mutate(async (state) => {
      if (kind === 'host_execution' && state.protection) {
        protectionError('personal_inference_host_isolation_required')
      }
      // A restart ended every process an earlier boot registered. Host and
      // runtime registrations from another boot go; credential runtimes keep
      // their own reconciliation. On dictator 405 had piled up toward the
      // 4096 this guard loads, and the native creator fenced on them.
      if (identity.bootId) {
        state.registrations = state.registrations.filter((item) => item.kind === 'credential_runtime'
          || item.bootId === undefined || item.bootId === identity.bootId)
      }
      const parsed = PersonalInferenceAuthoritySchema.safeParse(authority)
      state.registrations.push({ id, ...identity, label: label.slice(0, 200), kind,
        guardVersion: PERSONAL_INFERENCE_GUARD_VERSION,
        authority: parsed.success ? parsed.data : null })
    })
    return { id, release: async () => {
      await this.mutate(async (state) => {
        const item = state.registrations.find((registered) => registered.id === id)
        if (item?.kind === 'credential_runtime' && !await this.credentialProcessGone(item)) {
          protectionError('personal_inference_credential_process_live')
        }
        state.registrations = state.registrations.filter((registered) => registered.id !== id)
      })
    }, bindExecution: async (identity, descendants = []) => {
      if (!validExecutionIdentity(identity) || descendants.length > 4096
        || !descendants.every(validExecutionIdentity)) {
        return protectionError('personal_inference_runtime_unverified')
      }
      await this.mutate(async (state) => {
        const registration = state.registrations.find((item) => item.id === id)
        if (!registration || registration.kind !== 'host_execution') {
          return protectionError('personal_inference_admission_fenced')
        }
        registration.execution = { identity, descendants }
      })
    } }
  }

  registerRuntime(label: string): Promise<PersonalHostExecutionLease> { return this.register('runtime', label, null) }
  admitHostExecution(label: string, authority: unknown): Promise<PersonalHostExecutionLease> {
    return this.register('host_execution', label, authority)
  }

  /** All credential writes occur INSIDE the same admission lock, after compatibility proof. */
  async activate(input: PersonalInferenceProtection, saveCredentials: () => Promise<void>): Promise<void> {
    if (!validProtection(input)) return protectionError('personal_inference_guard_invalid')
    input = { ...input, principal: PersonalInferencePrincipalSchema.parse(input.principal) }
    const identity = await (this.options.processIdentity ?? ownProcessIdentity)()
    if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || !/^[0-9]+$/u.test(identity.startedAt)
      || identity.bootId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(identity.bootId)) {
      return protectionError('personal_inference_runtime_unverified')
    }
    await this.mutate(async (state) => {
      if (!this.options.verifyRuntimeInventory || !await this.options.verifyRuntimeInventory(state.registrations)) {
        protectionError('personal_inference_runtime_unverified')
      }
      if (state.protection
        && !samePersonalInferenceCustodian(state.protection.profiles[0]!.principal, input.principal)) {
        protectionError('personal_inference_other_custodian_active')
      }
      const previous = state.protection?.profiles.find(profile => profile.profileId === input.profileId)
      // A verified restart of the same account preserves local permission.
      // Replacement/generation/disclosure changes do not inherit it.
      if (previous && input.inferenceSource
        && sameExecutorInferenceSource(previous.inferenceSource, input.inferenceSource)
        && canonicalExecutorJson(previous.principal) === canonicalExecutorJson(input.principal)) {
        input = { ...input, backgroundConsentRevision: previous.backgroundConsentRevision }
      }
      const profiles = [
        ...(state.protection?.profiles ?? []).filter((profile) => profile.profileId !== input.profileId), input,
      ]
      if (profiles.length > 256) protectionError('personal_inference_guard_invalid')
      if (state.registrations.some((item) => item.guardVersion !== PERSONAL_INFERENCE_GUARD_VERSION
        || item.kind === 'host_execution')) {
        protectionError('personal_inference_incompatible_sessions')
      }
      // Publish the fence BEFORE writing any token. Failed/ambiguous credential writes
      // keep protection in place; they never restore unrestricted host execution.
      state.protection = { profiles }
      if (!state.registrations.some((item) => item.kind === 'credential_runtime'
        && item.pid === identity.pid && item.startedAt === identity.startedAt)) {
        state.registrations.push({ id: randomUUID(), ...identity, kind: 'credential_runtime',
          label: 'personal-credential-runtime', guardVersion: PERSONAL_INFERENCE_GUARD_VERSION, authority: null })
      }
      state.revision += 1
      await replaceOwnerOnlyJson(join(this.directory, 'guard.json'), state, this.options.security)
      await saveCredentials()
    })
  }

  /** Direct local owner action, under the same durable admission lock as activation. */
  async setBackgroundConsent(input: {
    profileId: string; principal: PersonalInferencePrincipal;
    inferenceSource: Extract<ExecutorInferenceSource, { kind: 'chatgpt' }>;
    enabled: boolean; expectedRevision: number | null;
  }): Promise<number | null> {
    return this.mutate(async state => {
      const profile = state.protection?.profiles.find(item => item.profileId === input.profileId)
      if (!profile || !sameExecutorInferenceSource(profile.inferenceSource, input.inferenceSource)
        || canonicalExecutorJson(profile.principal) !== canonicalExecutorJson(input.principal)
        || profile.backgroundConsentRevision !== input.expectedRevision
        || !Number.isSafeInteger(state.revision + 1)) {
        return protectionError('personal_inference_background_consent_fenced')
      }
      // The durable guard counter advances on every mutation, including
      // withdrawal. Re-enabling cannot resurrect an old automation grant.
      profile.backgroundConsentRevision = input.enabled ? state.revision + 1 : null
      return profile.backgroundConsentRevision
    })
  }

  /** Revocation/token deletion must finish before unrestricted host authority returns. */
  async deactivate(profileId: string, clearCredentials: () => Promise<void>): Promise<void> {
    await this.mutate(async (state) => {
      await clearCredentials()
      const profiles = state.protection?.profiles.filter((profile) => profile.profileId !== profileId) ?? []
      if (profiles.length === 0) {
        // Token deletion/AbortController cannot erase retained JS strings. A
        // separate noncredential controller must observe every owning process
        // generation gone before restoring arbitrary host execution.
        // Native mutations can also hold old token bytes. Their durable child
        // claims must reconcile positively even after credential files vanish.
        await new PersonalNativeWriters(this.directory, this.options.security,
          this.options.admissionLock?.processes).execute(async () => undefined)
        for (const item of state.registrations.filter((registered) => registered.kind === 'credential_runtime')) {
          if (!await this.credentialProcessGone(item)) protectionError('personal_inference_credential_process_live')
        }
        state.registrations = state.registrations.filter((item) => item.kind !== 'credential_runtime')
      }
      state.protection = profiles.length > 0 ? { profiles } : null
    })
  }

  async status(): Promise<Readonly<PersonalInferenceGuardState>> { return this.read() }
}
