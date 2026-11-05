import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** One OS-user path, independent of pairing, server, environment or model input. */
export const personalInferenceDirectory = (): string => join(homedir(), '.nessie', 'personal-inference')

export class PersonalInferenceProtectionError extends Error {
  override readonly name = 'PersonalInferenceProtectionError'
  constructor(readonly code: string) { super(code) }
}

const within = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return !part || !isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\')
}

/** Resolve missing tails against their nearest real parent; aliases cannot evade exclusions. */
const canonicalPath = async (path: string): Promise<string> => {
  const absolute = resolve(path)
  try { await lstat(absolute); return await realpath(absolute) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return resolve(await canonicalPath(parent), relative(parent, absolute))
  }
}

/** A grant/export must contain neither the protected tree nor any part of it. */
export const assertPersonalInferenceWorkspace = async (
  path: string, protectedDirectory = personalInferenceDirectory(),
): Promise<void> => {
  const [candidate, protectedPath] = await Promise.all([canonicalPath(path), canonicalPath(protectedDirectory)])
  if (within(candidate, protectedPath) || within(protectedPath, candidate)) {
    throw new PersonalInferenceProtectionError('personal_inference_protected_workspace')
  }
}

/** Paths touched by a product file operation can never access protected runtime state. */
export const assertPersonalInferenceFilePath = async (
  path: string, protectedDirectory = personalInferenceDirectory(),
): Promise<void> => {
  const [candidate, protectedPath] = await Promise.all([canonicalPath(path), canonicalPath(protectedDirectory)])
  if (within(protectedPath, candidate)) throw new PersonalInferenceProtectionError('personal_inference_protected_path')
}
