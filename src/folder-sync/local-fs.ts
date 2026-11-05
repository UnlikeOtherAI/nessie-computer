import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod, constants, copyFile, cp, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'

import { FOLDER_SYNC_RETENTION_DAYS } from '@nessie/executor-protocol'

import type { ExpectedLocal } from './types.js'

/**
 * Every filesystem effect folder sync has on the person's folder (plan §2.7,
 * §6). Paths are always resolved from the team folder and a mapped relative
 * path; links are never followed; every replacement is atomic and every
 * removal is a move into the owner-only trash. Windows I/O uses `\\?\` paths so
 * deep trees work.
 */

export class FolderSyncPathRefusedError extends Error {
  readonly code = 'EXECUTOR_FOLDER_SYNC_PATH_REFUSED'
}

/** The file is held by another program (C18): wait and retry, never force. */
export class FolderSyncFileBusyError extends Error {
  readonly code = 'EXECUTOR_FOLDER_SYNC_FILE_BUSY'
}

/** What the plan expected is no longer on disk: drop the action and replan. */
export class FolderSyncLocalDriftError extends Error {
  readonly code = 'EXECUTOR_FOLDER_SYNC_LOCAL_DRIFT'
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

/** An open or rename refused because another program holds the file. */
export const isBusyError = (error: unknown): boolean =>
  ['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY'].includes(errorCode(error) ?? '')

/** The OS form of an absolute path: `\\?\` on Windows, so length and reserved names never bite. */
export const fsPath = (absolute: string): string =>
  process.platform === 'win32' ? win32.toNamespacedPath(absolute) : absolute

const insideOrEqual = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * The absolute path of `relPath` under `root`. Refuses an absolute path, an
 * empty, `.` or `..` segment, NUL, a backslash, a drive or stream colon on
 * Windows, and anything that would resolve outside `root`. Absolute Windows
 * paths are refused on every host; ordinary POSIX colons remain valid.
 */
export const confinedPath = (root: string, relPath: string): string => {
  if (relPath === '') return resolve(root)
  const segments = relPath.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || /[\0\\]/u.test(segment)
      || (process.platform === 'win32' && segment.includes(':'))) {
      throw new FolderSyncPathRefusedError(`Refused path segment in ${JSON.stringify(relPath)}.`)
    }
  }
  const absolute = resolve(root, ...segments)
  if (isAbsolute(relPath) || win32.isAbsolute(relPath) || !insideOrEqual(resolve(root), absolute)) {
    throw new FolderSyncPathRefusedError(`${JSON.stringify(relPath)} leaves the sync folder.`)
  }
  return absolute
}

export type LocalStat = {
  type: 'file' | 'directory' | 'link' | 'other'
  /** `<dev>:<ino>` from a bigint `lstat`: the NTFS file index on Windows. */
  fileId: string
  size: number
  mtimeMs: number
}

export const lstatOrNull = async (absolute: string): Promise<LocalStat | null> => {
  try {
    const found = await lstat(fsPath(absolute), { bigint: true })
    return {
      type: found.isSymbolicLink() ? 'link' : found.isFile() ? 'file' : found.isDirectory() ? 'directory' : 'other',
      fileId: `${found.dev}:${found.ino}`,
      size: Number(found.size),
      mtimeMs: Number(found.mtimeMs),
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return null
    throw error
  }
}

const HASH_PREFIX = 'sha256:'
export const sha256 = (bytes: Uint8Array): string => `${HASH_PREFIX}${createHash('sha256').update(bytes).digest('hex')}`

/** Streaming SHA-256 of a file. A held file throws `FolderSyncFileBusyError`. */
export const hashFile = async (absolute: string): Promise<string> => {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(fsPath(absolute))) hash.update(chunk as Buffer)
  } catch (error) {
    if (isBusyError(error)) throw new FolderSyncFileBusyError(`${basename(absolute)} is in use.`)
    throw error
  }
  return `${HASH_PREFIX}${hash.digest('hex')}`
}

/**
 * Every directory from `root` (exclusive) down to `dirname(absolute)` exists
 * and is a real directory — no symlink, junction or reparse point on the way.
 * With `create`, missing ones are made (and then checked).
 */
export const assertLinkFreeParents = async (root: string, absolute: string, create = false): Promise<void> => {
  const rootPath = resolve(root)
  const rootStat = await lstatOrNull(rootPath)
  if (rootStat?.type !== 'directory') throw new FolderSyncPathRefusedError('The sync folder is not a directory.')
  const parts = relative(rootPath, dirname(resolve(absolute))).split(sep).filter(Boolean)
  let current = rootPath
  for (const part of parts) {
    current = join(current, part)
    let found = await lstatOrNull(current)
    if (found === null && create) {
      await mkdir(fsPath(current)).catch((error: unknown) => { if (errorCode(error) !== 'EEXIST') throw error })
      found = await lstatOrNull(current)
    }
    if (found === null) throw new FolderSyncLocalDriftError(`${part} is missing.`)
    if (found.type !== 'directory') {
      throw new FolderSyncPathRefusedError(`${part} is ${found.type === 'link' ? 'a link' : 'not a directory'}.`)
    }
  }
}

/**
 * The item at `absolute` is what the plan saw: absent for `null`; otherwise
 * the same file id (when the plan knew one) and the same bytes (when it knew
 * them). A link is never what a plan expected.
 */
export const matchesExpected = async (absolute: string, expected: ExpectedLocal | null): Promise<boolean> => {
  const found = await lstatOrNull(absolute)
  if (expected === null) return found === null
  if (found === null || found.type === 'link' || found.type === 'other') return false
  if (expected.fileId !== null && found.fileId !== expected.fileId) return false
  if (expected.contentHash === null) return true
  return found.type === 'file' && await hashFile(absolute) === expected.contentHash
}

/** Set or clear the OS read-only attribute (Windows) or the write bits (POSIX). */
export const setReadOnly = async (absolute: string, readOnly: boolean): Promise<void> => {
  await chmod(fsPath(absolute), readOnly ? 0o444 : 0o644)
}

const clearReadOnly = (absolute: string): Promise<void> => setReadOnly(absolute, false).catch(() => undefined)

/** A hidden name beside `absolute` (ignored by the scan); `tag` makes it findable after a crash. */
const hiddenSibling = (absolute: string, purpose: 'aside' | 'part', tag?: string): string =>
  join(dirname(absolute), `.nessie-sync-${purpose}-${tag ?? randomUUID().slice(0, 8)}`)

/** Move `from` to `to` even across volumes (`EXDEV`): copy, then remove the source. */
const moveAcrossVolumes = async (from: string, to: string, directory: boolean): Promise<void> => {
  try {
    await rename(fsPath(from), fsPath(to))
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error
    if (directory) {
      await cp(fsPath(from), fsPath(to), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
      await rm(fsPath(from), { recursive: true })
    } else {
      await copyFile(fsPath(from), fsPath(to), constants.COPYFILE_EXCL)
      await unlink(fsPath(from))
    }
  }
}

/**
 * Put `source` (a verified file, anywhere) at `target` atomically (A8). The
 * target must still be what the plan expected — absent for `expectHash` null,
 * otherwise exactly those bytes — checked immediately before the rename, after
 * `beforeRename` (the journal's install record) returns. On Windows a target
 * in the way is renamed aside first and put back if the swap fails, so the
 * person's file is never lost to a failed replace. A held file is
 * `FolderSyncFileBusyError`; the source stays where it was.
 */
export const installFile = async (
  root: string,
  source: string,
  target: string,
  options: {
    expectHash: string | null
    readOnly: boolean
    keepSource?: boolean
    /** Names the staged and aside siblings, so a replay can find them (`recoverInstall`). */
    tag?: string
    beforeRename?: () => Promise<void>
  },
): Promise<void> => {
  await assertLinkFreeParents(root, target, true)
  // Stage beside the target so the final step is a same-directory rename.
  const staged = hiddenSibling(target, 'part', options.tag)
  await unlink(fsPath(staged)).catch(() => undefined)
  if (options.keepSource) await copyFile(fsPath(source), fsPath(staged), constants.COPYFILE_EXCL)
  else await moveAcrossVolumes(source, staged, false)
  let restoreSource = !options.keepSource
  try {
    await options.beforeRename?.()
    const current = await lstatOrNull(target)
    if (options.expectHash === null ? current !== null
      : current?.type !== 'file' || await hashFile(target) !== options.expectHash) {
      throw new FolderSyncLocalDriftError(`${basename(target)} changed before it could be replaced.`)
    }
    if (current === null) {
      await rename(fsPath(staged), fsPath(target))
    } else {
      await replaceWithAside(staged, target, options.tag)
    }
    restoreSource = false
    if (options.readOnly) await setReadOnly(target, true)
  } catch (error) {
    // A moved source is always one the engine made (a download, a re-rendering,
    // a merge) and can make again: one that cannot go back is dropped, never
    // left beside the person's file under a hidden name.
    const dropStaged = () => unlink(fsPath(staged)).catch(() => undefined)
    if (restoreSource) await moveAcrossVolumes(staged, source, false).catch(dropStaged)
    else await dropStaged()
    if (isBusyError(error)) throw new FolderSyncFileBusyError(`${basename(target)} is in use.`)
    throw error
  }
}

const replaceWithAside = async (staged: string, target: string, tag?: string): Promise<void> => {
  if (process.platform !== 'win32') {
    await rename(fsPath(staged), fsPath(target))
    return
  }
  await clearReadOnly(target)
  const aside = hiddenSibling(target, 'aside', tag)
  await rename(fsPath(target), fsPath(aside))
  try {
    await rename(fsPath(staged), fsPath(target))
  } catch (error) {
    await rename(fsPath(aside), fsPath(target)).catch(() => undefined)
    throw error
  }
  await unlink(fsPath(aside)).catch(() => undefined)
}

/**
 * Rename an item within the folder. The source must be what the plan saw; the
 * target must be free (a case-only rename finds the source itself there, which
 * is allowed). Both parent chains are link-free.
 */
export const moveItem = async (
  root: string, from: string, to: string, expected: ExpectedLocal | null,
): Promise<void> => {
  await assertLinkFreeParents(root, from)
  await assertLinkFreeParents(root, to, true)
  if (!await matchesExpected(from, expected)) throw new FolderSyncLocalDriftError(`${basename(from)} changed.`)
  const source = await lstatOrNull(from)
  const occupant = await lstatOrNull(to)
  if (occupant !== null && occupant.fileId !== source?.fileId) {
    throw new FolderSyncLocalDriftError(`${basename(to)} is taken.`)
  }
  try {
    await rename(fsPath(from), fsPath(to))
  } catch (error) {
    if (isBusyError(error)) throw new FolderSyncFileBusyError(`${basename(from)} is in use.`)
    throw error
  }
}

/**
 * After a crash during `installFile(…, { tag })`: a person's file renamed aside
 * and never replaced comes back, and leftovers are removed. Run before the
 * install record is resolved by the target's hash.
 */
export const recoverInstall = async (target: string, tag: string): Promise<void> => {
  const aside = hiddenSibling(target, 'aside', tag)
  const staged = hiddenSibling(target, 'part', tag)
  if (await lstatOrNull(aside) !== null) {
    if (await lstatOrNull(target) === null) await rename(fsPath(aside), fsPath(target))
    else await clearReadOnly(aside).then(() => unlink(fsPath(aside))).catch(() => undefined)
  }
  await unlink(fsPath(staged)).catch(() => undefined)
}

const dayStamp = (now: number): string => new Date(now).toISOString().slice(0, 10)

/**
 * Move an item into `<trash>/<yyyy-mm-dd>/<relPath>` (R5): nothing synced is
 * ever deleted outright. A name already in the trash gets ` (n)`. Returns where
 * it went.
 */
export const trashItem = async (
  trashDir: string, root: string, relPath: string, expected: ExpectedLocal | null, now: number,
): Promise<string> => {
  const source = confinedPath(root, relPath)
  await assertLinkFreeParents(root, source)
  if (!await matchesExpected(source, expected)) throw new FolderSyncLocalDriftError(`${relPath} changed.`)
  const found = await lstatOrNull(source)
  if (found === null) throw new FolderSyncLocalDriftError(`${relPath} is gone.`)
  let target = confinedPath(join(trashDir, dayStamp(now)), relPath)
  for (let n = 2; await lstatOrNull(target) !== null; n += 1) {
    target = confinedPath(join(trashDir, dayStamp(now)), `${relPath} (${n})`)
  }
  await mkdir(fsPath(dirname(target)), { recursive: true })
  try {
    await moveAcrossVolumes(source, target, found.type === 'directory')
  } catch (error) {
    if (isBusyError(error)) throw new FolderSyncFileBusyError(`${basename(source)} is in use.`)
    throw error
  }
  return target
}

/** Keep bytes that are about to be replaced (a pre-merge text, R3) in the trash. */
export const keepCopyInTrash = async (
  trashDir: string, relPath: string, bytes: Uint8Array, now: number,
): Promise<string> => {
  let target = confinedPath(join(trashDir, dayStamp(now)), relPath)
  for (let n = 2; await lstatOrNull(target) !== null; n += 1) {
    target = confinedPath(join(trashDir, dayStamp(now)), `${relPath} (${n})`)
  }
  await mkdir(fsPath(dirname(target)), { recursive: true })
  await writeNewFile(target, bytes)
  return target
}

/** Keep a copy of a file in the folder that is about to be replaced (streamed; any size) in the trash. */
export const keepFileCopyInTrash = async (
  trashDir: string, root: string, relPath: string, now: number,
): Promise<string> => {
  let target = confinedPath(join(trashDir, dayStamp(now)), relPath)
  for (let n = 2; await lstatOrNull(target) !== null; n += 1) {
    target = confinedPath(join(trashDir, dayStamp(now)), `${relPath} (${n})`)
  }
  await mkdir(fsPath(dirname(target)), { recursive: true })
  await copyFile(fsPath(confinedPath(root, relPath)), fsPath(target), constants.COPYFILE_EXCL)
  return target
}

/** Move an item from outside the folder (the trash) to a free path inside it, across volumes if need be. */
export const moveIntoFolder = async (root: string, source: string, target: string): Promise<void> => {
  await assertLinkFreeParents(root, target, true)
  if (await lstatOrNull(target) !== null) throw new FolderSyncLocalDriftError(`${basename(target)} is taken.`)
  const found = await lstatOrNull(source)
  if (found === null || found.type === 'link') throw new FolderSyncLocalDriftError(`${basename(source)} is gone.`)
  await moveAcrossVolumes(source, target, found.type === 'directory')
}

/** Remove trash days older than the retention (30 days). */
export const sweepTrash = async (trashDir: string, now: number): Promise<void> => {
  const cutoff = dayStamp(now - FOLDER_SYNC_RETENTION_DAYS.localTrash * 24 * 60 * 60 * 1000)
  const days = await readdir(fsPath(trashDir)).catch(() => [] as string[])
  for (const day of days) {
    if (/^\d{4}-\d{2}-\d{2}$/u.test(day) && day < cutoff) {
      await rm(fsPath(join(trashDir, day)), { recursive: true, force: true, maxRetries: 2 })
    }
  }
}

/** Write bytes to a fresh owner-only file (a merge result, a staged copy). */
export const writeNewFile = async (absolute: string, bytes: Uint8Array): Promise<void> => {
  const handle = await open(fsPath(absolute), 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** libuv's `UV_FS_O_EXLOCK` on Windows (share mode 0); Node passes it through but does not export it. */
const EXCLUSIVE_LOCK = 0x1000_0000

/**
 * Open a file to upload it (A9). On Windows no other program may write it while
 * it is read (an exclusive open); a file an editor holds is
 * `FolderSyncFileBusyError`, and the entry waits.
 */
export const openForUpload = async (absolute: string): Promise<FileHandle> => {
  try {
    return await open(fsPath(absolute), process.platform === 'win32' ? constants.O_RDONLY | EXCLUSIVE_LOCK : 'r')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new FolderSyncLocalDriftError(`${basename(absolute)} is gone.`)
    if (isBusyError(error)) throw new FolderSyncFileBusyError(`${basename(absolute)} is in use.`)
    throw error
  }
}

/** The root's identity: its resolved real path, or null when it is gone, a link, or not a directory. */
export const rootRealPath = async (root: string): Promise<string | null> => {
  const found = await lstatOrNull(root)
  if (found?.type !== 'directory') return null
  return realpath(root).catch(() => null)
}

/** True when an existing directory accepts a new file (the root rule). */
export const directoryWritable = async (directory: string): Promise<boolean> => {
  const probe = join(directory, `.nessie-sync-probe-${randomUUID().slice(0, 8)}`)
  try {
    await writeNewFile(probe, new Uint8Array())
    await unlink(probe)
    return true
  } catch {
    return false
  }
}

export const isDirectory = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => null))?.isDirectory() === true
