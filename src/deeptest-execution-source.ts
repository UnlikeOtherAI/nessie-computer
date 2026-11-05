import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import type { DeepTestSourceSnapshot } from './deeptest-source-snapshot.js'
import { WorkspacePathError, configureOrdinaryDirectory, isInsideDirectory } from './workspace-paths.js'

const contentDigest = (content: Buffer): string => `sha256:${createHash('sha256').update(content).digest('hex')}`

const admittedFiles = (snapshot: DeepTestSourceSnapshot): Map<string, Buffer> => {
  if (!snapshot.coverage.complete || snapshot.working_tree_state !== 'clean') {
    throw new WorkspacePathError('The reviewed source snapshot is incomplete.')
  }
  const files = new Map<string, Buffer>()
  for (const file of snapshot.files) {
    if (file.status !== 'readable' || file.path === null || file.content === undefined) {
      throw new WorkspacePathError('The reviewed source snapshot is incomplete.')
    }
    if (
      file.path === '.git'
      || file.path.startsWith('.git/')
      || file.bytes !== file.content.byteLength
      || file.digest !== contentDigest(file.content)
      || files.has(file.path)
    ) {
      throw new WorkspacePathError('The reviewed source snapshot is unavailable.')
    }
    files.set(file.path, file.content)
  }
  return files
}

const targetPath = (root: string, sourcePath: string): string => {
  const target = resolve(root, sourcePath)
  if (!isInsideDirectory(root, target) || relative(root, target).split(sep).some((part) => !part || part === '.' || part === '..')) {
    throw new WorkspacePathError('The reviewed source path is unavailable.')
  }
  return target
}

const writeFile = async (path: string, content: Buffer): Promise<void> => {
  await mkdir(dirname(path), { mode: 0o700, recursive: true })
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    let offset = 0
    while (offset < content.byteLength) {
      const result = await handle.write(content, offset, content.byteLength - offset, offset)
      offset += result.bytesWritten
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Materializes only reviewed bytes; it intentionally creates no Git metadata. */
export const materializeDeepTestExecutionSource = async (
  stateDir: string,
  snapshot: DeepTestSourceSnapshot,
  assertActive: () => Promise<void> = async () => undefined,
): Promise<{ release: () => Promise<void>; workspaceRoot: string }> => {
  await assertActive()
  const stateRoot = await configureOrdinaryDirectory(stateDir, 'The executor state directory')
  const source = resolve(stateRoot, `.deeptest-execution-source-${randomUUID()}`)
  await mkdir(source, { mode: 0o700 })
  try {
    for (const [path, content] of admittedFiles(snapshot)) {
      await assertActive()
      await writeFile(targetPath(source, path), content)
    }
    await assertActive()
    return { release: async () => await rm(source, { force: true, recursive: true }), workspaceRoot: source }
  } catch (error) {
    await rm(source, { force: true, recursive: true })
    throw error
  }
}

const readExact = async (handle: Awaited<ReturnType<typeof open>>, size: number): Promise<Buffer> => {
  const content = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < content.byteLength) {
    const result = await handle.read(content, offset, content.byteLength - offset, offset)
    if (result.bytesRead === 0) throw new WorkspacePathError('The execution source changed.')
    offset += result.bytesRead
  }
  return content
}

const filesAt = async (root: string, expected: ReadonlyMap<string, Buffer>): Promise<Map<string, Buffer>> => {
  const files = new Map<string, Buffer>()
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = resolve(directory, entry.name)
      const info = await lstat(candidate)
      const path = relative(root, candidate).split(sep).join('/')
      if (info.isSymbolicLink()) throw new WorkspacePathError('The execution source changed.')
      if (info.isDirectory()) {
        if (![...expected.keys()].some((expectedPath) => expectedPath.startsWith(`${path}/`))) {
          throw new WorkspacePathError('The execution source changed.')
        }
        await walk(candidate)
      }
      else if (info.isFile()) {
        const admitted = expected.get(path)
        if (admitted === undefined || info.size !== admitted.byteLength || info.nlink !== 1) {
          throw new WorkspacePathError('The execution source changed.')
        }
        const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const opened = await handle.stat()
          if (
            !opened.isFile()
            || opened.dev !== info.dev
            || opened.ino !== info.ino
            || opened.size !== admitted.byteLength
            || opened.nlink !== 1
          ) {
            throw new WorkspacePathError('The execution source changed.')
          }
          files.set(path, await readExact(handle, admitted.byteLength))
        } finally {
          await handle.close()
        }
      }
      else throw new WorkspacePathError('The execution source changed.')
    }
  }
  await walk(root)
  return files
}

/** Verifies that the lease has precisely the admitted snapshot files and bytes. */
export const verifyDeepTestExecutionSource = async (
  workspaceRoot: string,
  snapshot: DeepTestSourceSnapshot,
): Promise<boolean> => {
  try {
    const expected = admittedFiles(snapshot)
    const actual = await filesAt(workspaceRoot, expected)
    return expected.size === actual.size && [...expected].every(([path, content]) => actual.get(path)?.equals(content))
  } catch {
    return false
  }
}
