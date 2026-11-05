import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { PersonalNativeWriters } from './personal-native-writers.js'
import { runPersonalNativeState } from './personal-native-state-runner.js'
import { acquirePersonalAdmissionLock } from './personal-admission-lock.js'
import { personalInferenceDirectory, PersonalInferenceProtectionError } from './personal-inference-paths.js'
import { collectExecutorRuntimeFacts, packagedRuntimeDirectory, verifyExecutorRuntime } from './runtime-integrity.js'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory, packagedNativeHelperPath } from './state-security.js'

export type PersonalStateMutationRequest =
  | { operation: 'replace'; bytes: Uint8Array; expectedDigest: string | null }
  | { operation: 'delete'; expectedDigest: string }

/** Process-crash atomic publication/CAS, without a physical power-loss claim. */
export type PersonalStateMutation = {
  readonly root: string
  readonly durability: 'process_crash'
  ensureDirectory: (path: string) => Promise<void>
  barrier: (directory: string) => Promise<void>
  mutate: (path: string, request: PersonalStateMutationRequest) => Promise<void>
}

const MAX_BYTES = 4 * 1024 * 1024
const fail = (code: string): never => { throw new PersonalInferenceProtectionError(code) }
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const validDigest = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value)
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

const validateRequest = (request: PersonalStateMutationRequest): void => {
  if (request.expectedDigest !== null && !validDigest(request.expectedDigest)) fail('personal_state_invalid')
  if (request.operation === 'replace' && request.bytes.byteLength > MAX_BYTES) fail('personal_state_invalid')
}

const scoped = (root: string, path: string, allowRoot: boolean): string => {
  if (!isAbsolute(path)) return fail('personal_state_invalid')
  const candidate = resolve(path)
  const tail = relative(root, candidate)
  if (isAbsolute(tail) || tail === '..' || tail.startsWith('../') || tail.startsWith('..\\')
    || !allowRoot && !tail) return fail('personal_state_invalid')
  return candidate
}

const windowsMutation = async (): Promise<PersonalStateMutation> => {
  if (process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') return fail('personal_state_native_unavailable')
  const directory = packagedRuntimeDirectory()
  const facts = await collectExecutorRuntimeFacts(directory, { runningBundlePath: process.argv[1] ?? '' })
  if (!verifyExecutorRuntime(facts).ok || facts.digests['nessie-executor-native.exe'] === undefined
    || await realpath(process.execPath) !== join(facts.directoryRealPath, 'nessie-executor-runtime.exe')) {
    return fail('personal_state_native_unavailable')
  }
  const helper = packagedNativeHelperPath()
  // Native context independently requires the pinned release signature and a
  // non-elevated regular-user token; SYSTEM/HOME cannot create another root.
  const context = await runPersonalNativeState(helper, ['personal-state-context'])
  if (context.protocolVersion !== 1 || context.durability !== 'process_crash'
    || context.kernelLock !== true || context.digestCas !== true || typeof context.root !== 'string'
    || !isAbsolute(context.root)) return fail('personal_state_context_rejected')
  const root = resolve(context.root)
  await ensureOwnerOnlyStateDirectory(root)
  const writers = new PersonalNativeWriters(root)
  return {
    root,
    durability: 'process_crash',
    ensureDirectory: async (path) => {
      await runPersonalNativeState(helper, ['personal-state-directory', scoped(root, path, true)], undefined, writers)
    },
    barrier: async (path) => {
      await runPersonalNativeState(helper, ['personal-state-barrier', scoped(root, path, true)], undefined, writers)
    },
    mutate: async (path, request) => {
      validateRequest(request)
      await runPersonalNativeState(helper, [
        request.operation === 'replace' ? 'personal-state-replace' : 'personal-state-delete',
        scoped(root, path, false), request.expectedDigest ?? 'absent',
      ], request.operation === 'replace' ? request.bytes : undefined, writers)
    },
  }
}

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

const posixMutation = async (): Promise<PersonalStateMutation> => {
  const owner = process.getuid?.()
  if (owner === undefined || owner === 0) return fail('personal_state_context_rejected')
  const root = resolve(personalInferenceDirectory())
  const protectedPath = (path: string): boolean => {
    const tail = relative(root, path)
    return !isAbsolute(tail) && tail !== '..' && !tail.startsWith('../')
  }
  const verifyAncestors = async (target: string): Promise<void> => {
    let current = dirname(target)
    while (true) {
      const entry = await lstat(current).catch((error: unknown) => {
        if (!missing(error)) throw error
        return null
      })
      if (entry) {
        if (protectedPath(current)) await assertOwnerOnlyStatePath(current, 'directory')
        else if (!entry.isDirectory() || entry.isSymbolicLink()
          || entry.uid !== owner && entry.uid !== 0 || (entry.mode & 0o022) !== 0) {
          fail('personal_state_invalid')
        }
        if (await realpath(current) !== current) fail('personal_state_invalid')
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  const ensureDirectory = async (path: string): Promise<void> => {
    const target = scoped(root, path, true)
    await verifyAncestors(target)
    const ensure = async (current: string): Promise<void> => {
      try {
        await lstat(current)
        if (protectedPath(current)) {
          await assertOwnerOnlyStatePath(current, 'directory')
        }
      } catch (error) {
        if (!missing(error)) throw error
        await ensure(dirname(current))
        await mkdir(current, { mode: 0o700 }).catch((creation) => {
          if ((creation as NodeJS.ErrnoException).code !== 'EEXIST') throw creation
        })
        await assertOwnerOnlyStatePath(current, 'directory')
        await syncDirectory(dirname(current))
      }
      if (await realpath(current) !== current) fail('personal_state_invalid')
    }
    await ensure(target)
    await verifyAncestors(target)
  }
  const directoryLock = async (parent: string) => {
    const lockDirectory = join(root, 'state-mutation-locks', digest(Buffer.from(parent)))
    await ensureDirectory(lockDirectory)
    return acquirePersonalAdmissionLock(lockDirectory)
  }
  return {
    root, durability: 'process_crash', ensureDirectory,
    barrier: async (path) => {
      const directory = scoped(root, path, true)
      await verifyAncestors(directory)
      await assertOwnerOnlyStatePath(directory, 'directory')
      if (await realpath(directory) !== directory) return fail('personal_state_invalid')
      const lock = await directoryLock(directory)
      try {
        for (const name of await readdir(directory)) {
          if (!name.startsWith('.state-draft-')) continue
          if (!/^\.state-draft-[a-f0-9]{64}$/u.test(name)) return fail('personal_state_invalid')
          const orphan = join(directory, name)
          await assertOwnerOnlyStatePath(orphan, 'file')
          const entry = await lstat(orphan)
          if (entry.nlink !== 1 || entry.size > MAX_BYTES) return fail('personal_state_invalid')
          await unlink(orphan)
        }
        await syncDirectory(directory)
      } finally { await lock.release() }
    },
    mutate: async (path, request) => {
      validateRequest(request)
      const target = scoped(root, path, false)
      const parent = dirname(target)
      await verifyAncestors(parent)
      await assertOwnerOnlyStatePath(parent, 'directory')
      if (await realpath(parent) !== parent) return fail('personal_state_invalid')
      const lock = await directoryLock(parent)
      const temporary = join(parent, `.state-draft-${digest(Buffer.from(target))}`)
      try {
        // A dead publisher cannot leave revoked credential bytes in a draft.
        await unlink(temporary).catch((error) => { if (!missing(error)) throw error })
        let current: string | null = null
        try {
          await assertOwnerOnlyStatePath(target, 'file')
          const entry = await lstat(target)
          if (entry.nlink !== 1 || entry.size > MAX_BYTES) return fail('personal_state_invalid')
          current = digest(await readFile(target))
        } catch (error) { if (!missing(error)) throw error }
        if (current !== request.expectedDigest) return fail('personal_state_conflict')
        if (request.operation === 'delete') await unlink(target)
        else {
          const file = await open(temporary, 'wx', 0o600)
          try { await file.writeFile(request.bytes); await file.sync() } finally { await file.close() }
          await rename(temporary, target)
        }
        await syncDirectory(parent)
      } finally {
        try { await unlink(temporary).catch((error) => { if (!missing(error)) throw error }) }
        finally { await lock.release() }
      }
    },
  }
}

/** Production platform factory; no injected verifier, shell fallback or service token writes. */
export const createPersonalStateMutation = async (): Promise<PersonalStateMutation> =>
  process.platform === 'win32' ? windowsMutation() : posixMutation()
