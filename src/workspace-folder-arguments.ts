import {
  deriveExecutorWorkspaceFolderName,
  type ExecutorWorkspaceFolder,
} from './workspace-folders.js'

export type { ExecutorWorkspaceFolder } from './workspace-folders.js'

/**
 * The two ways a caller names the host folders an executor may reach, kept in
 * one place because `pair`, `configure`, and the `--configuration-input-stdin`
 * form all have to agree about them.
 *
 *   --folder nessie=/Users/me/Projects/nessie --folder notes=/Users/me/Notes
 *   --workspace /Users/me/Projects/nessie
 *
 * `--workspace` is the single-folder spelling and stays supported verbatim:
 * `desktop/src-tauri/src/executor_companion/runtime.rs` calls it, and the name
 * is derived from the directory so that caller keeps working without knowing
 * folders have names. The two spellings are mutually exclusive — a call using
 * both says two things about the same policy.
 *
 * Nothing here decides whether a folder is acceptable. The grammar, the
 * duplicate and nesting rules, and the "is it really an ordinary directory"
 * checks all live in `configureExecutorWorkspaceFolders`, so a policy proposed
 * over stdin cannot reach a weaker set of rules than one typed on a terminal.
 */
export const parseExecutorWorkspaceFolderArguments = (
  args: readonly string[],
  required: boolean,
): ExecutorWorkspaceFolder[] | undefined => {
  const named = args.includes('--folder')
  const single = args.includes('--workspace')
  if (named && single) {
    throw new Error('Name the workspace folders with --folder, or give a single one with --workspace.')
  }
  if (single) {
    const path = args[args.indexOf('--workspace') + 1]
    if (!path || path.startsWith('--')) throw new Error('--workspace needs an absolute directory.')
    return [{ name: deriveExecutorWorkspaceFolderName(path), path }]
  }
  if (!named) {
    if (!required) return undefined
    throw new Error(
      'Give at least one --folder <name>=<absolute-path>, or a single --workspace <absolute-path>.',
    )
  }
  const folders: ExecutorWorkspaceFolder[] = []
  for (const [index, argument] of args.entries()) {
    if (argument !== '--folder') continue
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error('--folder needs <name>=<absolute-path>.')
    }
    // Split on the first `=` only: a host path may contain one, a name may not.
    const separator = value.indexOf('=')
    const name = separator < 0 ? '' : value.slice(0, separator)
    const path = separator < 0 ? '' : value.slice(separator + 1)
    if (!name || !path) throw new Error(`--folder needs <name>=<absolute-path>, not "${value}".`)
    folders.push({ name, path })
  }
  return folders
}

/**
 * The same folders as JSON on standard input, which is how the macOS app
 * proposes a policy. `workspaceRoot` is accepted as the single-folder spelling
 * for the same reason `--workspace` is, and for a caller that was written before
 * folders had names.
 */
export const workspaceFoldersFromInput = (
  value: unknown,
  label: string,
): ExecutorWorkspaceFolder[] => {
  const malformed = (): never => { throw new Error(`${label} is malformed.`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed()
  const input = value as { workspaceFolders?: unknown; workspaceRoot?: unknown }
  if (input.workspaceFolders !== undefined && input.workspaceRoot !== undefined) return malformed()
  if (input.workspaceFolders === undefined) {
    if (typeof input.workspaceRoot !== 'string' || !input.workspaceRoot) return malformed()
    return [{
      name: deriveExecutorWorkspaceFolderName(input.workspaceRoot),
      path: input.workspaceRoot,
    }]
  }
  if (!Array.isArray(input.workspaceFolders) || input.workspaceFolders.length === 0) return malformed()
  return input.workspaceFolders.map((folder) => {
    if (
      !folder
      || typeof folder !== 'object'
      || Array.isArray(folder)
      || Object.keys(folder as Record<string, unknown>).length !== 2
      || typeof (folder as ExecutorWorkspaceFolder).name !== 'string'
      || typeof (folder as ExecutorWorkspaceFolder).path !== 'string'
      || !(folder as ExecutorWorkspaceFolder).name
      || !(folder as ExecutorWorkspaceFolder).path
    ) return malformed()
    return {
      name: (folder as ExecutorWorkspaceFolder).name,
      path: (folder as ExecutorWorkspaceFolder).path,
    }
  })
}
