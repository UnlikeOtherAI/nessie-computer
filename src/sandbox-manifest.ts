import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { canonicalExecutorJson, RunIdSchema } from '@nessie/executor-protocol'

import { flushSandboxDrafts } from './guest-draft-ingest.js'
import {
  COPY_BUFFER_BYTES,
  MAX_SOURCE_FILES,
  assertOrdinaryDirectory,
  sandboxDraftFolderNames,
  sandboxFolderPaths,
  sandboxPaths,
} from './sandbox-layout.js'
import { executorWorkspacePath } from './workspace-folders.js'
import { WorkspacePathError, configureOrdinaryDirectory } from './workspace-paths.js'

/**
 * The content-hash manifest a snapshot writes beside itself and a review
 * compares the draft against. Nothing here opens a paired host folder: the
 * base manifest is the only memory of what the snapshot copied, and the draft
 * is hashed in place.
 *
 * A run drafts each workspace folder separately, so there is a manifest per
 * folder plus one run-level view of all of them. The two exist for different
 * readers and are deliberately not the same bytes:
 *
 *  - the per-folder manifest is what the native promotion helper verifies. Its
 *    paths are folder-relative, because the helper resolves them against one
 *    directory descriptor and recomputes this exact digest itself.
 *  - the run-level manifest is what a person reviews and what `workspace.promote`
 *    quotes back as the approval it is acting on. Its paths carry the folder
 *    name, because "changed README.md" is not a reviewable sentence when an
 *    executor can reach several folders.
 */

const MAX_REVIEW_CHANGES = 100
// Command receipts are capped at 64 KiB server-side. Keep margin for JSON
// escaping of otherwise valid local filenames and never turn a large review
// into an ambiguous terminal receipt.
const MAX_REVIEW_RESULT_BYTES = 60 * 1024

export type ManifestEntry = { byteCount: number; digest: string }
export type BaseManifest = { files: Record<string, ManifestEntry>; version: 1 }
export type WorkspaceChange = {
  base?: ManifestEntry
  draft?: ManifestEntry
  kind: 'created' | 'deleted' | 'modified'
  path: string
}

/** Exactly the fields the native promotion helper recomputes its digest over. */
export type SandboxFolderManifest = {
  changes: WorkspaceChange[]
  manifestDigest: string
  protocolVersion: 1
  runId: string
}

/** One folder's draft, with the host directory a promotion would write into. */
export type SandboxFolderPromotion = SandboxFolderManifest & {
  name: string
  /** The daemon-owned draft directory; never a paired host path. */
  workspace: string
}

export type SandboxPromotionManifest = {
  /** Every change in the run, each path prefixed with its folder name. */
  changes: WorkspaceChange[]
  /** The same changes per folder, each digested the way the helper will. */
  folders: SandboxFolderPromotion[]
  manifestDigest: string
  protocolVersion: 1
  runId: string
}

const digest = (value: Buffer | string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

export const relativeManifestPath = (workspace: string, path: string): string =>
  relative(workspace, path).split(sep).join('/')

const parseBaseManifest = (value: unknown): BaseManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
  }
  const manifest = value as { files?: unknown; version?: unknown }
  if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
  }
  const files: Record<string, ManifestEntry> = {}
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (
      path.length === 0
      || path.length > 1_024
      || path.includes('..')
      || !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || !Number.isInteger((entry as ManifestEntry).byteCount)
      || (entry as ManifestEntry).byteCount < 0
      || !/^sha256:[a-f0-9]{64}$/.test((entry as ManifestEntry).digest)
    ) {
      throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
    }
    files[path] = entry as ManifestEntry
    if (Object.keys(files).length > MAX_SOURCE_FILES) {
      throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
    }
  }
  return { files, version: 1 }
}

const readBaseManifest = async (path: string): Promise<BaseManifest> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink > 1 || info.size > 4 * 1024 * 1024) {
      throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
    }
    const bytes = Buffer.allocUnsafe(info.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== bytes.byteLength) throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
    try {
      return parseBaseManifest(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      if (error instanceof WorkspacePathError) throw error
      throw new WorkspacePathError('The executor sandbox base manifest is invalid.')
    }
  } finally {
    await handle.close()
  }
}

const workspaceManifest = async (workspace: string): Promise<Record<string, ManifestEntry>> => {
  const files: Record<string, ManifestEntry> = {}
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      throw new WorkspacePathError('Sandbox workspaces may not contain symbolic links.')
    }
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        await walk(resolve(path, entry.name))
      }
      return
    }
    if (!info.isFile() || info.nlink > 1) {
      throw new WorkspacePathError('Sandbox workspaces may contain only non-linked regular files.')
    }
    if (Object.keys(files).length >= MAX_SOURCE_FILES) {
      throw new WorkspacePathError('The sandbox workspace exceeds its storage limit.')
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const current = await handle.stat()
      if (!current.isFile() || current.nlink > 1 || current.size !== info.size) {
        throw new WorkspacePathError('The sandbox workspace changed during review.')
      }
      const hasher = createHash('sha256')
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
      let offset = 0
      while (offset < current.size) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset)
        if (bytesRead === 0) throw new WorkspacePathError('The sandbox workspace changed during review.')
        hasher.update(buffer.subarray(0, bytesRead))
        offset += bytesRead
      }
      files[relativeManifestPath(workspace, path)] = {
        byteCount: current.size,
        digest: `sha256:${hasher.digest('hex')}`,
      }
    } finally {
      await handle.close()
    }
  }
  await walk(workspace)
  return files
}

const changesFrom = (base: BaseManifest, current: Record<string, ManifestEntry>): WorkspaceChange[] => {
  const paths = [...new Set([...Object.keys(base.files), ...Object.keys(current)])].sort()
  const changes: WorkspaceChange[] = []
  for (const path of paths) {
    const before = base.files[path]
    const after = current[path]
    if (!before && after) changes.push({ draft: after, kind: 'created', path })
    else if (before && !after) changes.push({ base: before, kind: 'deleted', path })
    else if (before && after && (before.digest !== after.digest || before.byteCount !== after.byteCount)) {
      changes.push({ base: before, draft: after, kind: 'modified', path })
    }
  }
  return changes
}

/**
 * Reconstructs the exact, content-hash-bound manifests the native promotion
 * helper must verify — one per workspace folder this run drafted — and the
 * run-level view a person reviews. This opens no paired host folder and never
 * leaves the daemon; only the run digest is included in review receipts.
 */
export const promotionManifestForSandbox = async (
  stateDir: string,
  runId: string,
): Promise<SandboxPromotionManifest> => {
  const parsedRunId = RunIdSchema.parse(runId)
  const paths = await sandboxPaths(stateDir, runId)
  await assertOrdinaryDirectory(paths.root, 'The executor sandbox is unavailable.')
  // A guest whose shares are block devices holds its edits in a draft image
  // until they are streamed back. Reviewing before that flush would report a
  // change set the person has already made and cannot see.
  await flushSandboxDrafts(parsedRunId)
  const folders: SandboxFolderPromotion[] = []
  for (const name of await sandboxDraftFolderNames(stateDir, runId)) {
    const folderPaths = await sandboxFolderPaths(stateDir, runId, name)
    const workspace = await configureOrdinaryDirectory(
      folderPaths.workspace,
      'The executor sandbox workspace',
    )
    const [base, current] = await Promise.all([
      readBaseManifest(folderPaths.baseManifest),
      workspaceManifest(workspace),
    ])
    const unsigned = {
      changes: changesFrom(base, current),
      protocolVersion: 1 as const,
      runId: parsedRunId,
    }
    folders.push({
      ...unsigned,
      manifestDigest: digest(canonicalExecutorJson(unsigned)),
      name,
      workspace,
    })
  }
  const changes = folders.flatMap((folder) => folder.changes.map((change) => ({
    ...change,
    path: executorWorkspacePath(folder.name, change.path),
  })))
  if (changes.length > MAX_REVIEW_CHANGES) {
    throw new WorkspacePathError('The executor sandbox change set exceeds the review limit.')
  }
  const unsigned = { changes, protocolVersion: 1 as const, runId: parsedRunId }
  return {
    ...unsigned,
    folders,
    manifestDigest: digest(canonicalExecutorJson(unsigned)),
  }
}

/**
 * Returns the exact bounded delta between a run's COW snapshots and its drafts,
 * across every folder it touched. This is a review-only primitive: it never
 * opens or mutates a paired host folder.
 */
export const reviewSandboxWorkspace = async (
  stateDir: string,
  runId: string,
): Promise<Record<string, unknown>> => {
  const manifest = await promotionManifestForSandbox(stateDir, runId)
  const changes = manifest.changes.map(({ base, draft, kind, path }) => ({
    byteCount: draft?.byteCount ?? base!.byteCount,
    kind,
    path,
  }))
  const result = {
    changeCount: changes.length,
    changes,
    manifestDigest: manifest.manifestDigest,
    success: true,
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_REVIEW_RESULT_BYTES) {
    return {
      changeCount: changes.length,
      code: 'EXECUTOR_REVIEW_TOO_LARGE',
      success: false,
    }
  }
  return result
}
