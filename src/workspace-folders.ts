import { basename } from 'node:path'

import {
  EXECUTOR_WORKSPACE_FOLDER_MAXIMUM,
  EXECUTOR_WORKSPACE_FOLDER_NAME_MAXIMUM_LENGTH,
  executorWorkspaceFolderNameIsLegal,
} from '@nessie/executor-protocol'

import { WorkspacePathError, isInsideDirectory } from './workspace-paths.js'

/**
 * One namespace of named host folders, and the first segment of every workspace
 * path an agent writes.
 *
 * `file.list` with no path answers with the folder names themselves, so an
 * agent discovers what it can reach; `file.read nessie/api/src/index.ts` then
 * reads inside the folder named `nessie`. The first segment is resolved by
 * looking a name up in this list — never by path arithmetic — which is what
 * makes a cross-folder escape unrepresentable rather than merely refused. What
 * happens beneath a folder is the business of `workspace-paths.ts`, and both
 * levels enforce their own refusals.
 */
export type ExecutorWorkspaceFolder = { name: string; path: string }

/** The folder a workspace path names, and the path inside it. */
export type ExecutorWorkspacePathParts = {
  /** Absent only for the namespace root, which lists the folders themselves. */
  folderName?: string
  /** Always folder-relative and never `..`; `.` means the folder itself. */
  path: string
}

export const assertExecutorWorkspaceFolderName = (value: string): string => {
  if (!executorWorkspaceFolderNameIsLegal(value)) {
    throw new WorkspacePathError(
      `A workspace folder name is 1 to ${
        EXECUTOR_WORKSPACE_FOLDER_NAME_MAXIMUM_LENGTH
      } lowercase letters, digits and interior hyphens — not "${value.slice(0, 80)}".`,
    )
  }
  return value
}

/** What a directory name the grammar cannot accept becomes; see below. */
export const FALLBACK_EXECUTOR_WORKSPACE_FOLDER_NAME = 'workspace'

/**
 * The name a state file written before folders had names gets for its single
 * root, derived from that directory so an agent's paths read the way a person
 * expects: `/Users/me/Projects/nessie` becomes `nessie`.
 *
 * The derivation is total, not partial. Anything the grammar refuses — an empty
 * basename, a filesystem root, a name that is entirely punctuation or entirely
 * non-ASCII, a reserved Windows device name — becomes `workspace`. There is
 * nothing for it to collide with: this runs only for a state file that has
 * exactly one root, and an executor gains a second folder only through
 * `configure`, which validates names and refuses duplicates and nesting at that
 * point. A person who dislikes the derived name renames it with that same
 * command, which is a policy revision somebody reviews.
 */
export const deriveExecutorWorkspaceFolderName = (path: string): string => {
  const derived = basename(path.replaceAll('\\', '/'))
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+/gu, '')
    .slice(0, EXECUTOR_WORKSPACE_FOLDER_NAME_MAXIMUM_LENGTH)
    .replaceAll(/-+$/gu, '')
  return executorWorkspaceFolderNameIsLegal(derived)
    ? derived
    : FALLBACK_EXECUTOR_WORKSPACE_FOLDER_NAME
}

/**
 * Every rule a folder set has to satisfy before it is stored or enforced.
 *
 * Nesting is refused alongside duplicate names: two folders where one contains
 * the other would expose the same file under two names, which makes a receipt
 * ambiguous about what was read and a promotion ambiguous about what was
 * written. Names are lowercase-only by grammar, so a duplicate is already a
 * duplicate case-insensitively.
 */
export const assertExecutorWorkspaceFolders = (
  folders: readonly ExecutorWorkspaceFolder[],
): readonly ExecutorWorkspaceFolder[] => {
  if (folders.length === 0) throw new WorkspacePathError('A team needs at least one folder.')
  if (folders.length > EXECUTOR_WORKSPACE_FOLDER_MAXIMUM) {
    throw new WorkspacePathError(
      `A team may use at most ${EXECUTOR_WORKSPACE_FOLDER_MAXIMUM} folders.`,
    )
  }
  for (const folder of folders) assertExecutorWorkspaceFolderName(folder.name)
  if (new Set(folders.map((folder) => folder.name)).size !== folders.length) {
    throw new WorkspacePathError('Each workspace folder is named once.')
  }
  for (const folder of folders) {
    for (const other of folders) {
      if (other === folder) continue
      if (isInsideDirectory(other.path, folder.path)) {
        throw new WorkspacePathError(
          `The workspace folder "${folder.name}" is the same directory as "${
            other.name
          }" or lives inside it, so one file would have two names.`,
        )
      }
    }
  }
  return folders
}

export const executorWorkspaceFolderNames = (
  folders: readonly ExecutorWorkspaceFolder[],
): string[] => folders.map((folder) => folder.name).sort()

export const findExecutorWorkspaceFolder = (
  folders: readonly ExecutorWorkspaceFolder[],
  name: string,
): ExecutorWorkspaceFolder => {
  const found = folders.find((folder) => folder.name === name)
  if (!found) {
    throw new WorkspacePathError(
      `No workspace folder is named "${name.slice(0, 80)}". Reachable folders: ${
        executorWorkspaceFolderNames(folders).join(', ')
      }.`,
    )
  }
  return found
}

/**
 * Split a workspace path into the folder it names and the path inside it.
 *
 * `..` is refused outright rather than normalized away. Collapsing it would be
 * safe under one root — `resolve` plus a containment check catches what is left
 * — but here the first segment selects a folder, so `nessie/../secrets/key`
 * would collapse into a path that names a *different* folder. A path that
 * cannot be read at face value is refused instead.
 */
export const splitExecutorWorkspacePath = (value: string | undefined): ExecutorWorkspacePathParts => {
  const raw = value?.trim() ?? ''
  if (raw.includes('\0')) throw new WorkspacePathError('Workspace paths may not contain NUL.')
  // A drive letter is an absolute Windows host path, on either executor: read
  // as a folder name it was refused only by the name grammar, which told the
  // agent its folder was called "C:".
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/u.test(raw)) {
    throw new WorkspacePathError('Workspace paths must be relative.')
  }
  // Both separator spellings are interpreted before any decision is made: a
  // Windows executor accepts `\`, and a POSIX one must reject the same
  // Windows-shaped alias rather than treating the backslash as an ordinary byte.
  const segments = raw.replaceAll('\\', '/').split('/').filter((segment) => segment && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    throw new WorkspacePathError('Workspace paths may not contain "..".')
  }
  const [folderName, ...rest] = segments
  if (folderName === undefined) return { path: '.' }
  return { folderName: assertExecutorWorkspaceFolderName(folderName), path: rest.join('/') || '.' }
}

/** The path an agent wrote, as this executor read it, for echoing in a result. */
export const executorWorkspacePath = (folderName: string, path: string): string =>
  path === '.' ? folderName : `${folderName}/${path}`
