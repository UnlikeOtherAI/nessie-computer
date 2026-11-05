import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { isInsideDirectory } from './workspace-paths.js'
import { configureWorkspaceFolderPath } from './workspace.js'

export class DeepTestGitLayoutError extends Error {
  constructor(readonly inventoryLimit: boolean, message: string) {
    super(message)
    this.name = 'DeepTestGitLayoutError'
  }
}

const layoutError = (message: string): DeepTestGitLayoutError =>
  new DeepTestGitLayoutError(false, message)

export const assertDeepTestGitLayout = async (
  root: string,
  resolveGitPath: (args: readonly string[]) => Promise<string>,
): Promise<void> => {
  const declared = resolve(root, '.git')
  let info
  try {
    info = await lstat(declared)
  } catch {
    throw layoutError('The selected Nessie workspace must contain its own Git repository metadata.')
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw layoutError('Linked Git worktrees are not supported by this native source adapter yet.')
  }
  const gitDirectory = await realpath(declared)
  if (!isInsideDirectory(root, gitDirectory)) {
    throw layoutError('Git metadata must stay inside the selected Nessie workspace.')
  }
  // Validate before invoking Git: even rev-parse reads local configuration,
  // reference storage and shared-object metadata.
  await assertGitMetadataContained(root, gitDirectory)
  const resolvedGitDirectory = await configureWorkspaceFolderPath(
    await resolveGitPath(['rev-parse', '--path-format=absolute', '--git-dir']),
  )
  const commonDirectory = await configureWorkspaceFolderPath(
    await resolveGitPath(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  )
  if (
    !isInsideDirectory(root, resolvedGitDirectory)
    || !isInsideDirectory(root, commonDirectory)
    || resolvedGitDirectory !== gitDirectory
    || commonDirectory !== gitDirectory
  ) throw layoutError('This repository uses Git metadata outside the supported native source layout.')
}

const assertGitMetadataContained = async (root: string, gitDirectory: string): Promise<void> => {
  for (const name of ['commondir', 'config.worktree']) {
    if (await exists(join(gitDirectory, name))) {
      throw layoutError('Git worktree and shared metadata layouts are not supported by this native source adapter.')
    }
  }
  const configPath = join(gitDirectory, 'config')
  const configInfo = await lstat(configPath)
  if (!configInfo.isFile() || configInfo.isSymbolicLink()) {
    throw layoutError('Git configuration must be an ordinary file inside the selected workspace.')
  }
  if (configInfo.size > 1024 * 1024) {
    throw new DeepTestGitLayoutError(true, 'Git configuration is too large for the native source adapter to verify.')
  }
  const config = await readFile(configPath, 'utf8')
  if (/^\s*\[\s*include(?:if)?\b/imu.test(config)) {
    throw layoutError('Git configuration includes are not supported by this native source adapter.')
  }
  // HEAD, refs, packed-refs, shallow and reftable files can redirect reference
  // reads just as object links can. Inspect the complete metadata tree.
  const pending = [gitDirectory]
  let visited = 0
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    const directoryInfo = await lstat(directory)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw layoutError('Git metadata must stay in ordinary directories inside the selected workspace.')
    }
    if (!isInsideDirectory(root, await realpath(directory))) {
      throw layoutError('Git metadata must stay inside the selected workspace.')
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      visited += 1
      if (visited > 1_000_000) {
        throw new DeepTestGitLayoutError(
          true,
          'This repository metadata is too large for the native source adapter to verify.',
        )
      }
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw layoutError('Git metadata contains a link or special entry outside the supported layout.')
      }
      if (entry.isDirectory()) pending.push(join(directory, entry.name))
    }
  }
  for (const name of ['alternates', 'http-alternates']) {
    if (await exists(join(gitDirectory, 'objects', 'info', name))) {
      throw layoutError('Git alternate object databases are not supported by this native source adapter.')
    }
  }
}

const exists = async (candidate: string): Promise<boolean> => {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
