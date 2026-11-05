import { lstat, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export class WorkspaceCleanupRequiredError extends Error {
  constructor() {
    super('Remove every local draft and stop every sandbox before replacing this pairing or changing its workspace folders.')
    this.name = 'WorkspaceCleanupRequiredError'
  }
}

/**
 * Drafts and sandboxes belong to the folder set that produced them, so the whole
 * set is frozen while any of them exist. This is deliberately the run-level
 * runtime directory rather than a per-folder check: a draft in one folder can
 * have been promoted against, reviewed alongside, or written by a guest that also
 * read another, and a manifest that referred to a folder the policy no longer
 * names could not be reviewed honestly. Adding, removing, renaming or repointing
 * any folder is refused until the runtime directory is empty.
 */
export const assertWorkspaceMayChange = async (stateDir: string): Promise<void> => {
  const runtimeDirectory = resolve(stateDir, 'runtime')
  let metadata
  try {
    metadata = await lstat(runtimeDirectory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return
    throw cause
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Local executor runtime state must be an ordinary directory.')
  }
  if ((await readdir(runtimeDirectory)).length > 0) {
    throw new WorkspaceCleanupRequiredError()
  }
}
