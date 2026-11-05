import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, statfs, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { safeFetch } from '@nessie/executor-support/url-safety'
import type { LocalModelFile } from '@nessie/executor-protocol'
import { localModelFileUrl } from '@nessie/executor-protocol'

/**
 * Fetching the bytes of a local model, with the digest as the only thing that
 * decides whether they are the right bytes.
 *
 * The pin is `file.sha256`, which came from the catalogue compiled into this
 * binary — not from the server, not from a manifest in the bucket, and not
 * from the response. A URL here is only how the bytes are asked for; if what
 * comes back hashes to anything else, it is discarded and the failure is
 * terminal rather than retried into a loop.
 *
 * Ollama hashes the file independently when it is imported, so a corrupted
 * download has to get past two checks that were computed in different
 * processes from different code. That is the half of Kelpie's model story
 * this replaces: its catalogue shipped `sha256: ''`, a hash nobody had.
 *
 * Every failure here is a returned outcome, never a throw. A caller that had
 * to catch for only the filesystem cases would forget.
 */

/** Ollama's import copies the blob, so the volume needs the file again, plus slack. */
const OLLAMA_COPY_FACTOR = 1.2

/** Enough for a redirect onto the CDN edge and no more; weights carry no credentials. */
const MAX_REDIRECTS = 2

const LOCK_FILE = '.downloading'

/**
 * How long an unreadable lock must sit before it is treated as wreckage.
 *
 * An exclusive create makes the lock file visible before its JSON is written,
 * so "empty" means either a live writer a microsecond ahead of us or a crash
 * that truncated it. Only age tells those apart, and guessing wrong in the
 * optimistic direction puts two writers on one partial file.
 */
const LOCK_STALE_MS = 60_000

export type WeightsFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<Response>

/**
 * The part of a file handle this module uses, as a seam.
 *
 * A short write is the failure worth testing here and it cannot be provoked
 * through the public surface, so the handle is injectable the same way the
 * transport and `statfs` already are.
 */
export type StagedFileHandle = {
  close: () => Promise<void>
  truncate: (length: number) => Promise<void>
  write: (
    data: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesWritten: number }>
}

export type OpenStagedFile = (
  path: string,
  flags: string,
  mode: number,
) => Promise<StagedFileHandle>

const defaultOpenStagedFile: OpenStagedFile = async (path, flags, mode) => {
  const handle = await open(path, flags, mode)
  return {
    close: () => handle.close(),
    truncate: (length) => handle.truncate(length),
    write: async (data, offset, length, position) => {
      const { bytesWritten } = await handle.write(data, offset, length, position)
      return { bytesWritten }
    },
  }
}

/** Errno codes that mean the disk refused us, not that the mirror did. */
const FILESYSTEM_ERROR_CODES = new Set([
  'EACCES',
  'EBADF',
  'EDQUOT',
  'EFBIG',
  'EIO',
  'EISDIR',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'EPERM',
  'EROFS',
])

const defaultWeightsFetch: WeightsFetch = (url, init) =>
  safeFetch(url, init, { maxRedirects: MAX_REDIRECTS })

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes: number
}

export type DownloadFailureReason =
  /** The object is not the length the catalogue pinned — a different build behind the same URL. */
  | 'size_mismatch'
  /** The bytes arrived whole and hashed to something else. Terminal. */
  | 'digest_mismatch'
  /** Not enough room for what is left to fetch and Ollama's copy of the result. */
  | 'no_storage'
  /** Another process on this machine holds the lock for this file. */
  | 'download_in_progress'
  /** The mirror could not be reached, or answered something unusable. */
  | 'mirror_unreachable'
  /** The disk refused us for a reason that is not simply being full. */
  | 'local_error'

export type DownloadOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: DownloadFailureReason; observedDigest?: string; detail?: string }

export const localModelsDirectory = (stateDir: string): string => resolve(stateDir, 'local-models')

/** One directory per catalogue entry; the digest names the file inside it. */
export const stagedFilePath = (stateDir: string, entryId: string, file: LocalModelFile): string =>
  resolve(localModelsDirectory(stateDir), entryId, `${file.sha256}.part`)

export const verifiedFilePath = (stateDir: string, entryId: string, file: LocalModelFile): string =>
  resolve(localModelsDirectory(stateDir), entryId, `${file.sha256}.gguf`)

type ResumeMetadata = { etag?: string }

const metadataPath = (partPath: string): string => `${partPath}.meta`

const readResumeMetadata = async (partPath: string): Promise<ResumeMetadata> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(metadataPath(partPath), 'utf8'))
    const etag = (parsed as { etag?: unknown } | null)?.etag
    return typeof etag === 'string' && etag.length > 0 ? { etag } : {}
  } catch {
    return {}
  }
}

/** Cleanup must never be the thing that fails an operation that otherwise succeeded. */
const removeQuietly = async (path: string): Promise<void> => {
  try {
    await rm(path, { force: true })
  } catch {
    // The next attempt will overwrite or re-derive it.
  }
}

const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const readLockHolder = async (lockPath: string): Promise<number | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'))
    const pid = (parsed as { pid?: unknown } | null)?.pid
    return typeof pid === 'number' ? pid : undefined
  } catch {
    return undefined
  }
}

const lockAgeMs = async (lockPath: string, now: number): Promise<number | undefined> => {
  try {
    return now - (await stat(lockPath)).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Hold the lock, or say who does.
 *
 * A download that died leaves its lock behind; a download still running must
 * not have its `.part` written by a second process. A readable lock is decided
 * by whether its pid is alive. An *unreadable* one is the dangerous case — the
 * exclusive create publishes the file before the JSON lands, so a competitor
 * arriving in that window would otherwise read nothing, call it abandoned and
 * take the lock the first process already holds. Unreadable therefore means
 * "occupied" until it is old enough that no live writer could have left it so.
 */
const acquireLock = async (
  lockPath: string,
  now: () => number = () => Date.now(),
): Promise<boolean> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: new Date(now()).toISOString() }),
        { flag: 'wx' },
      )
      return true
    } catch (error) {
      // Only "it already exists" is contention. A permission or space failure
      // must not be reported to the caller as somebody else downloading.
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error

      const holder = await readLockHolder(lockPath)
      if (holder !== undefined && isPidAlive(holder)) return false
      if (holder === undefined) {
        const age = await lockAgeMs(lockPath, now())
        // Gone already, or too young to be anything but a live writer mid-write.
        if (age === undefined || age < LOCK_STALE_MS) return false
      }

      // Reclaiming is itself a race: if two of us both saw the same dead
      // holder and both simply deleted it, the slower one's delete would
      // remove the *winner's* fresh lock and both would write one partial
      // file. Renaming is the atomic claim — `rename` of a given path
      // succeeds for exactly one caller, and everyone else gets ENOENT. So
      // whoever moves the corpse aside has earned the right to retry, and
      // the rest back off rather than deleting a lock that may already be
      // somebody's.
      const reclaimPath = `${lockPath}.reclaim.${process.pid}.${randomUUID()}`
      try {
        await rename(lockPath, reclaimPath)
      } catch {
        return false
      }
      await removeQuietly(reclaimPath)
    }
  }
  return false
}

/** Hash a file from disk, so a resumed download continues one digest rather than starting a second. */
const hashFileFromDisk = async (
  path: string,
): Promise<{ bytes: number; hash: ReturnType<typeof createHash> } | undefined> => {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return undefined
  }
  if (size === 0) return undefined
  const hash = createHash('sha256')
  await new Promise<void>((resolveHash, rejectHash) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash())
      .on('error', rejectHash)
  })
  return { bytes: size, hash }
}

/**
 * `bytes <start>-<end>/<total>`.
 *
 * The start matters as much as the total: a mirror that answers `206` from
 * offset zero to a request that asked for byte 2 000 000 000 would otherwise
 * have its body written at our offset, producing a file that is garbage in a
 * way only the final digest notices — gigabytes later.
 */
export const parseContentRange = (
  header: string | null,
): { start: number; total: number } | undefined => {
  if (header === null) return undefined
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header.trim())
  if (!match?.[1] || !match[3]) return undefined
  const start = Number.parseInt(match[1], 10)
  const total = Number.parseInt(match[3], 10)
  if (!Number.isSafeInteger(start) || start < 0) return undefined
  return Number.isSafeInteger(total) && total > 0 ? { start, total } : undefined
}

/**
 * Is there room for `requiredBytes` on the volume holding `directory`?
 *
 * A volume that will not answer `statfs` is not a reason to refuse a download —
 * the write itself will fail loudly enough, and that path now returns
 * `no_storage` too.
 */
export const hasRoomFor = async (
  directory: string,
  requiredBytes: number,
  probe: (path: string) => Promise<{ bavail: number; bsize: number }> = statfs,
): Promise<{ ok: true } | { ok: false; availableBytes: number; requiredBytes: number }> => {
  try {
    const stats = await probe(directory)
    const available = stats.bavail * stats.bsize
    return available >= requiredBytes ? { ok: true } : { ok: false, availableBytes: available, requiredBytes }
  } catch {
    return { ok: true }
  }
}

export type DownloadOptions = {
  baseUrl: string
  entryId: string
  file: LocalModelFile
  stateDir: string
  fetchImpl?: WeightsFetch
  /**
   * Re-hash a file already sitting under its final name instead of trusting
   * its length. The fast path exists because a multi-gigabyte re-hash on every
   * pull is not free; this is how a caller that has *learned* the file is bad
   * — Ollama rejected its digest — gets the cached copy thrown away rather
   * than being handed it again forever.
   */
  revalidateCached?: boolean
  onProgress?: (progress: DownloadProgress) => void
  openImpl?: OpenStagedFile
  statfsImpl?: (path: string) => Promise<{ bavail: number; bsize: number }>
}

const asFilesystemFailure = (error: unknown): DownloadOutcome => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const detail = error instanceof Error ? error.message : 'filesystem error'
  return code === 'ENOSPC'
    ? { ok: false, reason: 'no_storage', detail: 'the volume is full' }
    : { ok: false, reason: 'local_error', detail }
}

export const downloadModelFile = async (options: DownloadOptions): Promise<DownloadOutcome> => {
  try {
    return await runDownload(options)
  } catch (error) {
    // mkdir, the metadata write, the promotion rename — any of them can fail,
    // and none of them should reach a caller as a rejected promise when every
    // other failure in this module is a value.
    return asFilesystemFailure(error)
  }
}

const runDownload = async (options: DownloadOptions): Promise<DownloadOutcome> => {
  const { baseUrl, entryId, file, stateDir } = options
  const fetchImpl = options.fetchImpl ?? defaultWeightsFetch
  const finalPath = verifiedFilePath(stateDir, entryId, file)
  const partPath = stagedFilePath(stateDir, entryId, file)

  const cached = await stat(finalPath).catch(() => undefined)
  if (cached !== undefined && cached.size === file.bytes) {
    if (options.revalidateCached !== true) return { ok: true, path: finalPath }
    const rehashed = await hashFileFromDisk(finalPath)
    if (rehashed !== undefined && rehashed.hash.digest('hex') === file.sha256) {
      return { ok: true, path: finalPath }
    }
    // Same length, wrong bytes. Without this the cache would answer "ready"
    // for a corrupted file on every future attempt, with no way back.
    await removeQuietly(finalPath)
  }

  await mkdir(dirname(partPath), { recursive: true, mode: 0o700 })

  const lockPath = resolve(dirname(partPath), LOCK_FILE)
  if (!(await acquireLock(lockPath))) return { ok: false, reason: 'download_in_progress' }

  try {
    const partial = await hashFileFromDisk(partPath)

    // A `.part` that is already the full length means we died between the last
    // write and the digest check. We have just hashed it, so the answer is in
    // hand — finishing it costs nothing, where re-downloading costs gigabytes.
    // Deliberately before the space check: a file that needs no more bytes
    // must not be refused for want of room to fetch them.
    if (partial !== undefined && partial.bytes === file.bytes) {
      const completed = partial.hash.digest('hex')
      if (completed === file.sha256) {
        await rename(partPath, finalPath)
        await removeQuietly(metadataPath(partPath))
        return { ok: true, path: finalPath }
      }
      await removeQuietly(partPath)
      await removeQuietly(metadataPath(partPath))
      return { ok: false, reason: 'digest_mismatch', observedDigest: completed }
    }

    // Only the bytes still to fetch need room, plus Ollama's copy of the
    // result. Charging for the whole file again would refuse a resume on a
    // disk that has ample space for what is actually left.
    const alreadyOnDisk = partial?.bytes ?? 0
    const required =
      file.bytes - alreadyOnDisk + Math.ceil(file.bytes * OLLAMA_COPY_FACTOR)
    const room = await hasRoomFor(dirname(partPath), required, options.statfsImpl)
    if (!room.ok) {
      return {
        ok: false,
        reason: 'no_storage',
        detail: `needs ${room.requiredBytes} bytes, ${room.availableBytes} free`,
      }
    }

    const metadata = partial === undefined ? {} : await readResumeMetadata(partPath)
    const headers: Record<string, string> = {}
    const wantsResume = partial !== undefined && partial.bytes < file.bytes
    if (wantsResume && partial !== undefined) {
      headers.Range = `bytes=${partial.bytes}-`
      // `If-Range`, not `If-Match`. If the object moved, `If-Match` answers 412
      // forever: the partial is kept, every retry re-sends the same stale
      // validator, and the failure reads as a network problem. `If-Range`
      // degrades to a plain 200 of the current object, which the restart path
      // below already handles, so a rotated mirror self-heals in one attempt.
      if (metadata.etag !== undefined) headers['If-Range'] = metadata.etag
    }

    let response: Response
    try {
      response = await fetchImpl(localModelFileUrl(file, baseUrl), { headers })
    } catch (error) {
      return {
        ok: false,
        reason: 'mirror_unreachable',
        detail: error instanceof Error ? error.message : 'request failed',
      }
    }

    if (response.status !== 200 && response.status !== 206) {
      return { ok: false, reason: 'mirror_unreachable', detail: `HTTP ${response.status}` }
    }

    // A 206 must be a slice of the object the catalogue pinned. A 200 means the
    // mirror ignored the range (or the validator moved), so the prefix on disk
    // is not ours and the hash starts again from nothing.
    let resuming = false
    if (response.status === 206) {
      // A 206 we did not ask for has no prefix to continue, so there is no
      // offset it could be correct at.
      if (!wantsResume || partial === undefined) return { ok: false, reason: 'size_mismatch' }
      const range = parseContentRange(response.headers.get('content-range'))
      if (range === undefined || range.total !== file.bytes) {
        return { ok: false, reason: 'size_mismatch' }
      }
      if (range.start !== partial.bytes) return { ok: false, reason: 'size_mismatch' }
      // A cache edge that served the range without honouring `If-Range` would
      // splice a different object onto our prefix. Comparing the validator we
      // were given costs nothing and catches it before the transfer, rather
      // than at the digest check several gigabytes later.
      const servedEtag = response.headers.get('etag')
      if (metadata.etag !== undefined && servedEtag !== null && servedEtag !== metadata.etag) {
        return { ok: false, reason: 'size_mismatch' }
      }
      resuming = true
    } else {
      const declared = response.headers.get('content-length')
      if (declared !== null && Number.parseInt(declared, 10) !== file.bytes) {
        return { ok: false, reason: 'size_mismatch' }
      }
    }

    const hash = resuming && partial !== undefined ? partial.hash : createHash('sha256')
    let written = resuming && partial !== undefined ? partial.bytes : 0

    const etag = response.headers.get('etag')
    if (etag !== null && !resuming) {
      await writeFile(metadataPath(partPath), JSON.stringify({ etag }), { mode: 0o600 })
    }

    try {
      const handle = await (options.openImpl ?? defaultOpenStagedFile)(
        partPath,
        resuming ? 'r+' : 'w',
        0o600,
      )
      try {
        if (resuming) await handle.truncate(written)
        const body = response.body
        if (body === null) return { ok: false, reason: 'mirror_unreachable', detail: 'empty body' }
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
          if (written + chunk.byteLength > file.bytes) return { ok: false, reason: 'size_mismatch' }
          // `write` may store fewer bytes than it was given. Advancing by the
          // chunk length regardless would leave a hole on disk while the hash
          // — computed from the stream, not the file — still matched, and a
          // file with holes in it would then be promoted as verified.
          let offset = 0
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await handle.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              written + offset,
            )
            if (bytesWritten <= 0) throw new Error('the volume accepted no bytes')
            offset += bytesWritten
          }
          hash.update(chunk)
          written += chunk.byteLength
          options.onProgress?.({ downloadedBytes: written, totalBytes: file.bytes })
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      // A volume that fills mid-stream, a disk that refuses us, or a
      // connection that drops — three different things, and calling a disk
      // failure a mirror failure sends somebody to debug their network. The
      // `.part` survives in every case, so the next attempt resumes.
      const code = (error as NodeJS.ErrnoException | null)?.code
      const detail = error instanceof Error ? error.message : 'transfer failed'
      if (code === 'ENOSPC') {
        return { ok: false, reason: 'no_storage', detail: 'the volume filled during the transfer' }
      }
      return code !== undefined && FILESYSTEM_ERROR_CODES.has(code)
        ? { ok: false, reason: 'local_error', detail }
        : { ok: false, reason: 'mirror_unreachable', detail }
    }

    if (written !== file.bytes) return { ok: false, reason: 'size_mismatch' }

    const observedDigest = hash.digest('hex')
    if (observedDigest !== file.sha256) {
      // Terminal, and the partial goes with it: keeping it would resume a
      // download whose prefix we already know to be wrong.
      await removeQuietly(partPath)
      await removeQuietly(metadataPath(partPath))
      return { ok: false, reason: 'digest_mismatch', observedDigest }
    }

    await rename(partPath, finalPath)
    await removeQuietly(metadataPath(partPath))
    return { ok: true, path: finalPath }
  } finally {
    await removeQuietly(lockPath)
  }
}
