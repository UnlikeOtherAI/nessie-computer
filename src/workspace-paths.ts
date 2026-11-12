import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { assertPersonalInferenceFilePath, assertPersonalInferenceWorkspace } from './personal-inference-paths.js'

export const EXECUTOR_PROMOTION_JOURNAL_DIRECTORY = '.nessie-executor-promotions'

export class WorkspacePathError extends Error {
  override readonly name = 'WorkspacePathError'
}

export const isInsideDirectory = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * Normalise a path already known to be folder-relative, and refuse the shapes
 * that must never reach a filesystem call.
 *
 * `..` is refused rather than collapsed. Under a single root, collapsing it and
 * then re-checking containment was safe; it is not safe once the first segment
 * of an agent's path selects which folder it means, because a collapsed path can
 * name a different folder than the one it was written against. The folder split
 * in `workspace-folders.ts` refuses `..` for that reason, and this refuses it
 * again so no caller can reach a resolver through a weaker door.
 */
export const safeRelativeWorkspacePath = (value: string | undefined): string => {
  const path = value?.trim() || '.'
  if (path.includes('\0') || isAbsolute(path) || path.startsWith('/') || path.startsWith('\\')) {
    throw new WorkspacePathError('Workspace paths must be relative.')
  }
  // Interpret both separator spellings before making reserved-path decisions.
  // A Windows executor accepts `/` and `\\`, while POSIX must still reject a
  // Windows-shaped alias instead of treating the backslash as an ordinary byte.
  const segments = path.replaceAll('\\', '/').split('/').filter((segment) => segment && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    throw new WorkspacePathError('Workspace paths may not contain "..".')
  }
  const normalized = segments.join('/') || '.'
  if (
    normalized === EXECUTOR_PROMOTION_JOURNAL_DIRECTORY
    || normalized.startsWith(`${EXECUTOR_PROMOTION_JOURNAL_DIRECTORY}/`)
  ) {
    throw new WorkspacePathError('Workspace paths may not access Nessie Computer’s journal state.')
  }
  return normalized
}

/** Validate a canonical ordinary directory without following a declared link. */
export const configureOrdinaryDirectory = async (value: string, label: string): Promise<string> => {
  if (!isAbsolute(value)) throw new WorkspacePathError(`${label} must be absolute.`)
  const declared = resolve(value)
  const declaredInfo = await lstat(declared)
  if (declaredInfo.isSymbolicLink() || !declaredInfo.isDirectory()) {
    throw new WorkspacePathError(`${label} must be an ordinary directory.`)
  }
  const canonical = await realpath(declared)
  const canonicalInfo = await lstat(canonical)
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()) {
    throw new WorkspacePathError(`${label} is no longer an ordinary directory.`)
  }
  return canonical
}

/**
 * Resolve an existing path beneath a root while rejecting every symbolic-link
 * component. The caller receives a canonical path only after the final target
 * exists, is real, and remains beneath the root.
 */
export const resolveExistingWorkspacePath = async (
  folderRoot: string,
  requestedPath: string,
): Promise<string> => {
  const root = await configureOrdinaryDirectory(folderRoot, 'The workspace folder')
  await assertPersonalInferenceWorkspace(root)
  const unresolved = resolve(root, safeRelativeWorkspacePath(requestedPath))
  if (!isInsideDirectory(root, unresolved)) {
    throw new WorkspacePathError('Workspace path escapes its folder.')
  }
  let current = root
  for (const segment of relative(root, unresolved).split(sep).filter(Boolean)) {
    current = resolve(current, segment)
    if ((await lstat(current)).isSymbolicLink()) {
      throw new WorkspacePathError('Workspace paths may not traverse symbolic links.')
    }
  }
  const canonical = await realpath(unresolved)
  await assertPersonalInferenceFilePath(canonical)
  if (!isInsideDirectory(root, canonical)) {
    throw new WorkspacePathError('Workspace path resolves outside its folder.')
  }
  return canonical
}

/** Validate all existing parent components for a path that may be created. */
export const resolveWorkspaceWritePath = async (
  folderRoot: string,
  requestedPath: string,
): Promise<{ path: string; relativePath: string; root: string }> => {
  const root = await configureOrdinaryDirectory(folderRoot, 'The workspace folder')
  await assertPersonalInferenceWorkspace(root)
  const relativePath = safeRelativeWorkspacePath(requestedPath)
  if (relativePath === '.') throw new WorkspacePathError('A workspace file path is required.')
  const destination = resolve(root, relativePath)
  await assertPersonalInferenceFilePath(destination)
  if (!isInsideDirectory(root, destination)) {
    throw new WorkspacePathError('Workspace path escapes its folder.')
  }
  const segments = relative(root, destination).split(sep).filter(Boolean)
  let current = root
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new WorkspacePathError('Workspace paths may not traverse symbolic links.')
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        break
      }
      throw error
    }
  }
  return { path: destination, relativePath, root }
}
