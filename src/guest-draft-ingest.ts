import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  GUEST_DRAFT_READ_MAX_BYTES,
  type GuestDraftEntry,
} from './guest-vm-payloads.js'
import { resolveWorkspaceWritePath, WorkspacePathError } from './workspace-paths.js'

/**
 * A guest that mounts its workspace as block devices writes into an ext4 draft
 * image the host cannot read, so the draft comes back over the control channel
 * instead — and the host never parses a filesystem the guest wrote. Every path
 * the guest names is re-validated here through the same no-follow resolver the
 * promotion path uses: `..`, an absolute path, the promotion journal, and any
 * symbolic-link component are refused, so a hostile guest can write only inside
 * this run's own overlay directory.
 *
 * On a virtiofs host nothing calls this: the guest's writes already landed in
 * that directory. `workspace.review` and promotion therefore keep the exact
 * contracts they have — they read one directory, whichever way it was filled.
 */
const MAX_DRAFT_FILES = 10_000
const MAX_DRAFT_BYTES = 128 * 1024 * 1024
/** A scan that never terminates must not become an unbounded host loop. */
const MAX_SCAN_PAGES = 1_024

export type GuestDraftReader = {
  readDraft: (path: string, offset: number) => Promise<{ bytes: Buffer; eof: boolean }>
  scanDrafts: (cursor: number) => Promise<{ entries: GuestDraftEntry[]; next?: number }>
}

const missing = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')

const applyDirectory = async (destination: string, opaque: boolean): Promise<void> => {
  // An opaque directory is a deletion of everything the lower layer had there.
  // Dropping it first is what makes `rm -rf dir` visible to review; overlayfs
  // writes no per-child whiteout in that case.
  if (opaque) await rm(destination, { force: true, recursive: true })
  else {
    try {
      const info = await lstat(destination)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new WorkspacePathError('A workspace draft may not replace a file with a directory.')
      }
      return
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  await mkdir(destination, { mode: 0o700 })
}

const applyFile = async (
  reader: GuestDraftReader,
  entry: GuestDraftEntry,
  destination: string,
): Promise<number> => {
  const previous = await lstat(destination).catch((error: unknown) => {
    if (!missing(error)) throw error
    return undefined
  })
  if (previous?.isSymbolicLink()) throw new WorkspacePathError('A draft may not write through a symbolic link.')
  // Windows has no O_NOFOLLOW. An exclusive sibling plus rename never opens the destination link or inode.
  const temporary = join(dirname(destination), `.nessie-draft-${randomUUID()}`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    let offset = 0
    for (;;) {
      const chunk = await reader.readDraft(entry.path, offset)
      let written = 0
      while (written < chunk.bytes.byteLength) {
        const result = await handle.write(chunk.bytes, written, chunk.bytes.byteLength - written, offset + written)
        written += result.bytesWritten
      }
      offset += chunk.bytes.byteLength
      if (offset > MAX_DRAFT_BYTES) {
        throw new WorkspacePathError('The workspace draft exceeds its storage limit.')
      }
      if (chunk.eof) break
      if (chunk.bytes.byteLength === 0) {
        throw new WorkspacePathError('The executor guest stalled while returning a workspace draft.')
      }
      if (chunk.bytes.byteLength > GUEST_DRAFT_READ_MAX_BYTES) {
        throw new WorkspacePathError('The executor guest returned an oversized workspace draft chunk.')
      }
    }
    await handle.sync()
    await handle.close()
    await rename(temporary, destination)
    return offset
  } finally {
    await handle.close()
    await rm(temporary, { force: true })
  }
}

/**
 * Streams every changed entry of the guest's draft overlay into the run's
 * host-side overlay directory. Deletions arrive as overlayfs whiteouts and are
 * applied as removals, so a file the guest deleted stops existing here too and
 * `reviewSandboxWorkspace` reports it as `deleted` exactly as on macOS.
 */
export const ingestGuestDrafts = async (
  reader: GuestDraftReader,
  overlayDirectory: string,
): Promise<{ bytes: number; files: number }> => {
  let bytes = 0
  let files = 0
  let cursor = 0
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const scan = await reader.scanDrafts(cursor)
    for (const entry of scan.entries) {
      files += 1
      if (files > MAX_DRAFT_FILES) {
        throw new WorkspacePathError('The workspace draft exceeds its file-count limit.')
      }
      const destination = await resolveWorkspaceWritePath(overlayDirectory, entry.path)
      if (entry.kind === 'dir') await applyDirectory(destination.path, entry.opaque === true)
      else if (entry.kind === 'whiteout') await rm(destination.path, { force: true, recursive: true })
      else {
        bytes += await applyFile(reader, entry, destination.path)
        if (bytes > MAX_DRAFT_BYTES) {
          throw new WorkspacePathError('The workspace draft exceeds its storage limit.')
        }
      }
    }
    if (scan.next === undefined) return { bytes, files }
    if (scan.next <= cursor) {
      throw new WorkspacePathError('The executor guest returned a non-advancing workspace draft cursor.')
    }
    cursor = scan.next
  }
  throw new WorkspacePathError('The executor guest returned an unterminated workspace draft listing.')
}

export type SandboxDraftFlush = () => Promise<void>

/**
 * The daemon's `workspace.review` and `workspace.promote` reach the overlay
 * through `sandbox-workspace.ts`, which cannot know a guest is live. A session
 * that owns a block-mode draft registers its flush here for the duration, so
 * review sees the guest's current work without either side learning about the
 * other's transport. The registry is process-local, exactly like the live
 * session it tracks.
 */
const flushes = new Map<string, SandboxDraftFlush>()

export const registerSandboxDraftSource = (runId: string, flush: SandboxDraftFlush): void => {
  flushes.set(runId, flush)
}

export const releaseSandboxDraftSource = (runId: string, flush: SandboxDraftFlush): void => {
  if (flushes.get(runId) === flush) flushes.delete(runId)
}

export const flushSandboxDrafts = async (runId: string): Promise<void> => {
  await flushes.get(runId)?.()
}
