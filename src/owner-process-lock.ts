import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, open, readFile, realpath, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { currentKernelBootId, nativeKernelProcessGeneration } from './kernel-boot.js'
import { createCodingProcessControl } from './coding-session/process-control.js'
import { assertOwnerOnlyStatePath, secureOwnerOnlyStateFile, type StateSecurityDeps } from './state-security.js'

export type OwnerProcessIdentity = { pid: number; startedAt: string }
export type OwnerProcessInspector = {
  identify: (pid: number) => Promise<OwnerProcessIdentity | undefined>
  /** Undefined identity can also mean I/O failure; only confirmed absence permits recovery. */
  isAlive: (pid: number) => boolean
}
type Claim = OwnerProcessIdentity & ({ version: 1; token: string }
  | { version: 2; token: string; bootId: string })
type LegacyPidClaim = { legacy: 'physical_pid'; pid: number; token: string }
type Observation = { claim: Claim | LegacyPidClaim; ino: number; dev: number; digest: string }

export type OwnerProcessLockOptions = {
  security?: StateSecurityDeps
  /** Only the named canonical lifecycle file may contain the historical PID format. */
  legacyPid?: boolean
  /** Lifecycle-only migration evidence; never used by the personal custody lock. */
  legacyOwnerAbsent?: (pid: number, startedAt?: string) => Promise<boolean>
  processes?: OwnerProcessInspector
  /** A fresh actual boot read, never an age-based lease expiry. */
  kernelBootId?: () => Promise<string | undefined>
  /** Deterministic crash boundaries for tests; production provides neither. */
  beforePublish?: () => Promise<void>
  afterPublish?: () => Promise<void>
  afterRecoveryPublish?: () => Promise<void>
}

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const START = /^[0-9]+$/u
const BOOT = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
export class OwnerProcessLockError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'OwnerProcessLockError' }
}
const fail = (code: string): never => { throw new OwnerProcessLockError(code) }
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

export const createOwnerProcessInspector = (): OwnerProcessInspector => {
  const control = createCodingProcessControl()
  return {
    identify: async (pid) => {
      if (['darwin', 'win32'].includes(process.platform) && process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1') {
        try {
          const generation = await nativeKernelProcessGeneration(pid)
          return { pid: generation.pid, startedAt: generation.startedAt }
        } catch { return undefined } // The independent isAlive check distinguishes unknown from absence.
      }
      const result = await control.identify(pid)
      return result?.startedAt ? { pid: result.pid, startedAt: result.startedAt } : undefined
    },
    isAlive: (pid) => {
      try { process.kill(pid, 0); return true }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
    },
  }
}

const sameObservation = (left: Observation, right: Observation): boolean =>
  left.ino === right.ino && left.dev === right.dev && left.digest === right.digest

/**
 * Fully publish the process-generation claim before the canonical name exists.
 * A crash during writing/security/sync leaves only an unreferenced unique draft;
 * no competitor can observe an ownerless canonical admission lock.
 */
const prepareLock = async (
  directory: string, lockName: string, options: OwnerProcessLockOptions,
) => {
  if (!/^[a-z][a-z0-9-]*\.(?:lock|pid)$/u.test(lockName)) return fail('owner_process_admission_invalid')
  await assertOwnerOnlyStatePath(directory, 'directory', options.security)
  const canonicalDirectory = await realpath(directory)
  const processes = options.processes ?? createOwnerProcessInspector()
  const bootReader = options.kernelBootId ?? currentKernelBootId

  const observe = async (path: string): Promise<Observation | null> => {
    try {
      const before = await lstat(path)
      await assertOwnerOnlyStatePath(path, 'file', options.security)
      const bytes = await readFile(path)
      if (bytes.length > 4096) return fail('owner_process_admission_invalid')
      const digest = createHash('sha256').update(bytes).digest('hex')
      let claim: Claim | LegacyPidClaim
      const rawPid = bytes.toString('utf8').trim()
      if (options.legacyPid && path === join(canonicalDirectory, lockName)
        && /^[1-9][0-9]{0,9}$/u.test(rawPid) && Number(rawPid) <= 2147483647) {
        // This token identifies immutable observed bytes, never an invented birth.
        claim = { legacy: 'physical_pid', pid: Number(rawPid),
          token: createHash('sha256').update(`legacy:${before.dev}:${before.ino}:${digest}`).digest('hex') }
      } else {
        let parsed: unknown
        try { parsed = JSON.parse(bytes.toString('utf8')) }
        catch { return fail('owner_process_admission_invalid') }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return fail('owner_process_admission_invalid')
        }
        const candidate = parsed as Partial<Claim>
        if ((candidate.version === 1
          ? Object.keys(candidate).sort().join(',') !== 'pid,startedAt,token,version'
          : candidate.version !== 2 || Object.keys(candidate).sort().join(',') !== 'bootId,pid,startedAt,token,version'
            || typeof candidate.bootId !== 'string' || !BOOT.test(candidate.bootId))
          || !Number.isSafeInteger(candidate.pid) || (candidate.pid ?? 0) < 1
          || typeof candidate.startedAt !== 'string' || !START.test(candidate.startedAt)
          || typeof candidate.token !== 'string' || !TOKEN.test(candidate.token)) {
          return fail('owner_process_admission_invalid')
        }
        claim = candidate as Claim
      }
      const after = await lstat(path)
      if (before.ino !== after.ino || before.dev !== after.dev) return null
      return { claim, ino: after.ino, dev: after.dev, digest }
    } catch (error) {
      if (missing(error)) return null
      if (['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        // NTFS may deny reopening an observed name while another claimant's
        // deletion is pending. This is unknown/busy, never positive absence
        // and never permission to reclaim an unreadable live generation.
        return fail('owner_process_admission_busy')
      }
      throw error
    }
  }

  const generationState = async (claim: Claim | LegacyPidClaim): Promise<'live' | 'dead' | 'unknown'> => {
    if (!('legacy' in claim) && claim.version === 2) {
      const currentBoot = await bootReader()
      if (!currentBoot || !BOOT.test(currentBoot)) return 'unknown'
      if (claim.bootId !== currentBoot) return 'dead'
    }
    const current = await processes.identify(claim.pid)
    if ('legacy' in claim) {
      if (current === undefined && !processes.isAlive(claim.pid)) return 'dead'
      return await options.legacyOwnerAbsent?.(claim.pid, current?.startedAt) ? 'dead' : 'unknown'
    }
    return current ? current.startedAt === claim.startedAt ? 'live' : 'dead'
      : processes.isAlive(claim.pid) ? 'unknown' : 'dead'
  }
  return { canonicalDirectory, processes, bootReader, observe, generationState }
}

export type OwnerProcessLockState = 'absent' | 'live' | 'dead' | 'unknown'

/** Read-only status uses the exact same generation decision as acquisition. */
export const readOwnerProcessLock = async (
  directory: string, lockName: string, options: OwnerProcessLockOptions = {},
): Promise<OwnerProcessLockState> => {
  const context = await prepareLock(directory, lockName, options)
  const observed = await context.observe(join(context.canonicalDirectory, lockName))
  return observed ? context.generationState(observed.claim) : 'absent'
}

export const acquireOwnerProcessLock = async (
  directory: string, lockName: string, options: OwnerProcessLockOptions = {},
): Promise<{ release: () => Promise<void> }> => {
  const context = await prepareLock(directory, lockName, options)
  const { canonicalDirectory, processes, bootReader, observe, generationState } = context
  const bootId = await bootReader()
  if (bootId !== undefined && !BOOT.test(bootId) || process.platform === 'linux' && bootId === undefined) {
    return fail('owner_process_runtime_unverified')
  }
  const owner = await processes.identify(process.pid)
  if (!owner || owner.pid !== process.pid || !START.test(owner.startedAt)) return fail('owner_process_runtime_unverified')
  const deadGeneration = async (claim: Claim | LegacyPidClaim) => await generationState(claim) === 'dead'

  const acquire = async (path: string, lineage = new Set<string>()): Promise<{
    observation: Observation; release: () => Promise<void>
  }> => {
    const claim: Claim = bootId
      ? { ...owner, version: 2, bootId, token: randomUUID() }
      : { ...owner, version: 1, token: randomUUID() }
    const draft = join(canonicalDirectory, `admission-claim-${claim.token}.json`)
    const file = await open(draft, 'wx', 0o600)
    try {
      try { await file.writeFile(`${JSON.stringify(claim)}\n`); await file.sync() }
      finally { await file.close() }
      await secureOwnerOnlyStateFile(draft, options.security)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (lineage.size === 0) await options.beforePublish?.()
        try {
          await link(draft, path)
          const metadata = await lstat(path)
          const observation = { claim, ino: metadata.ino, dev: metadata.dev,
            digest: createHash('sha256').update(`${JSON.stringify(claim)}\n`).digest('hex') }
          if (lineage.size === 0) await options.afterPublish?.()
          return { observation, release: async () => {
            const current = await observe(path)
            if (!current || !sameObservation(observation, current)) {
              return fail('owner_process_admission_fenced')
            }
            await unlink(path)
          } }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        const previous = await observe(path)
        if (!previous) continue
        if (!await deadGeneration(previous.claim)) return fail('owner_process_admission_busy')

        // Recovery is serialized FOR THIS EXACT GENERATION. Its lock is itself
        // atomically owner-published and recoverable after a reclaimer crash.
        // Names use the generation token, not path spelling or wall-clock age.
        if (lineage.has(previous.claim.token)) return fail('owner_process_admission_invalid')
        const nextLineage = new Set([...lineage, previous.claim.token])
        const recoveryPath = join(dirname(path), `admission-recovery-${
          createHash('sha256').update(previous.claim.token).digest('hex')
        }.lock`)
        const recovery = await acquire(recoveryPath, nextLineage)
        try {
          await options.afterRecoveryPublish?.()
          const current = await observe(path)
          if (current && sameObservation(previous, current) && await deadGeneration(current.claim)) {
            // No other reclaimer of this generation can replace the canonical
            // name until this recovery owner finishes. The dead owner cannot
            // release it, and a new acquirer cannot publish before this unlink.
            await unlink(path)
          }
        } finally { await recovery.release() }
      }
      return fail('owner_process_admission_busy')
    } finally {
      await unlink(draft).catch((error: unknown) => { if (!missing(error)) throw error })
    }
  }
  const acquired = await acquire(join(canonicalDirectory, lockName))
  return { release: acquired.release }
}
