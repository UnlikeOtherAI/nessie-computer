import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  FOLDER_SYNC_MARKDOWN_MAX_BYTES,
  type FolderSyncPageResponse,
  type SyncPage,
} from '@nessie/executor-protocol'

import type { StateSecurityDeps } from '../state-security.js'
import type { ConflictBook } from './report.js'
import { entryFor, keepsBaseText, localOf } from './engine-entries.js'
import type { EngineStore } from './engine-store.js'
import {
  FolderSyncLocalDriftError,
  confinedPath,
  fsPath,
  hashFile,
  installFile,
  keepCopyInTrash,
  keepFileCopyInTrash,
  lstatOrNull,
  matchesExpected,
  openForUpload,
  sha256,
  writeNewFile,
  type LocalStat,
} from './local-fs.js'
import type { LocalScanner } from './local-scan.js'
import { mergeText } from './merge.js'
import { baseName, nameKey, parentPath } from './path-mapping.js'
import { uploadSessionKey } from './reconcile-model.js'
import type { FolderSyncPaths } from './state-files.js'
import type { FolderSyncTransport, FolderSyncUploadSource } from './transport.js'
import { TornReadError } from './transport.js'
import { recordTrashed } from './trash-book.js'
import type { ReconcileAction, RemoteParent, SyncEntryBase } from './types.js'

/**
 * The actions that move bytes or write Nessie (plan §2.7, amendments A5, A8,
 * A11): downloads installed only over what the plan saw, uploads that stream
 * while hashing, creates keyed by `pageKey`, and three-way merges. Every write
 * answer goes through `afterWrite`, which is where an entry becomes `synced`
 * — only after the file on disk re-hashes to what was sent.
 */

export type RunnerContext = {
  teamDir: string
  paths: FolderSyncPaths
  store: EngineStore
  transport: FolderSyncTransport
  /** The manifest's pages, updated by every write answer and 409 in this pass. */
  pages: Map<string, SyncPage>
  /** Pages this pass learned are gone. */
  gone: Set<string>
  scanner: LocalScanner
  book: ConflictBook
  now: () => number
  /** `createRemote` keys → the pages they made, for children naming a pending parent. */
  pageKeys: Map<string, string>
  /** The revision each of this pass's own writes returned: the next write on that page uses it. */
  ownRevisions: Map<string, number>
  /** Copy paths → the copy pages created this pass. */
  copiesCreated: Map<string, string>
  /** Ask for another pass soon (something changed under the plan). */
  replan: () => void
  security: StateSecurityDeps
  /** How many downloads and uploads of one batch run at once. */
  concurrency: { downloads: number; uploads: number }
}

/** The download's bytes did not hash to what the server announced. */
export class DownloadCorruptError extends Error {}

/** The local text cannot go to Nessie as a document (over 5 MiB, or not UTF-8). */
export class DocumentUnsendableError extends Error {}

const MIME_BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv', html: 'text/html',
  json: 'application/json', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export const mimeFor = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return (dot > 0 && MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream'
}

const decoder = new TextDecoder('utf-8', { fatal: true })

const markdownOf = (bytes: Uint8Array): string => {
  if (bytes.length > FOLDER_SYNC_MARKDOWN_MAX_BYTES) throw new DocumentUnsendableError('The document is over 5 MiB.')
  try {
    return decoder.decode(bytes)
  } catch {
    throw new DocumentUnsendableError('The document is not UTF-8 text.')
  }
}

const memorySource = (bytes: Uint8Array, expectedHash: string): FolderSyncUploadSource => ({
  byteLength: bytes.length,
  expectedHash,
  read: async (offset, length) => bytes.subarray(offset, offset + length),
})

/**
 * Read the file the plan saw, through an exclusive open on Windows (A9). The
 * file id must match; the bytes must hash to what the plan saw (A5).
 */
const withUploadSource = async <T>(
  absolute: string,
  expected: { fileId: string | null; contentHash: string | null } | null,
  use: (source: FolderSyncUploadSource, whole: () => Promise<Uint8Array>) => Promise<T>,
): Promise<T> => {
  if (!expected?.contentHash) throw new FolderSyncLocalDriftError('The plan did not see these bytes.')
  const handle = await openForUpload(absolute)
  try {
    const stat = await handle.stat({ bigint: true })
    if (expected.fileId !== null && `${stat.dev}:${stat.ino}` !== expected.fileId) {
      throw new FolderSyncLocalDriftError('The file was replaced.')
    }
    const byteLength = Number(stat.size)
    const read = async (offset: number, length: number): Promise<Uint8Array> => {
      const buffer = Buffer.alloc(length)
      let filled = 0
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      return buffer.subarray(0, filled)
    }
    const whole = async () => {
      const bytes = await read(0, byteLength)
      if (sha256(bytes) !== expected.contentHash) throw new TornReadError()
      return bytes
    }
    return await use({ byteLength, expectedHash: expected.contentHash, read }, whole)
  } finally {
    await handle.close()
  }
}

/**
 * A document's Markdown, read whole under the exclusive open and released
 * before it is sent, so an editor saving during the request is not refused;
 * its save is the next generation (A5).
 */
const readDocument = (
  absolute: string, expected: { fileId: string | null; contentHash: string | null } | null,
): Promise<string> => withUploadSource(absolute, expected, async (_source, whole) => markdownOf(await whole()))

/** Fetch a version into `pending/` and prove its bytes; the `.part` resumes on a retry. */
export const fetchVerified = async (
  ctx: RunnerContext, pageId: string, versionId: string, contentHash: string, byteLength: number,
): Promise<string> => {
  const part = join(ctx.paths.pending, `${pageId}.${versionId}.part`)
  await ctx.transport.download(pageId, versionId, part, byteLength)
  if (await hashFile(part) !== contentHash) {
    await rm(fsPath(part), { force: true })
    throw new DownloadCorruptError('The download did not match its hash.')
  }
  return part
}

/**
 * The file at `absolute` as it is now: its stat and the hash of the bytes
 * read (null when it moved while it was read), and the bytes themselves when
 * `keepBytes`. Nothing is assumed from what sync wrote there a moment ago — a
 * person may have saved over it since.
 */
const readOnDisk = async (
  absolute: string, keepBytes: boolean,
): Promise<{ found: LocalStat | null; hash: string | null; bytes: Uint8Array | null }> => {
  const found = await lstatOrNull(absolute)
  if (found?.type !== 'file') return { found, hash: null, bytes: null }
  const bytes = keepBytes ? new Uint8Array(await readFile(fsPath(absolute))) : null
  const hash = bytes ? sha256(bytes) : await hashFile(absolute)
  const after = await lstatOrNull(absolute)
  const still = after !== null && after.fileId === found.fileId && after.size === found.size
    && after.mtimeMs === found.mtimeMs
  return still ? { found, hash, bytes } : { found: after, hash: null, bytes: null }
}

/**
 * Record a page's content as now on disk at `relPath`, agreed at `base`. The
 * entry's local hash is the hash of the bytes actually there: a save that
 * landed after the install (or after the write answered) stays a local
 * change and uploads, and only bytes that hash to the base become the merge
 * base (A7) — never another generation under the base's name.
 */
export const recordOnDisk = async (
  ctx: RunnerContext, page: SyncPage, relPath: string, base: SyncEntryBase,
  state: 'synced' | 'pending_upload' = 'synced',
  /** The base's bytes when the caller holds them (a verified download), kept even if the file moved on. */
  baseBytes?: Uint8Array,
): Promise<void> => {
  const absolute = confinedPath(ctx.teamDir, relPath)
  const keepText = base.contentHash !== null && keepsBaseText(page)
  const { found, hash, bytes } = await readOnDisk(absolute, keepText && !baseBytes)
  const agreed = found?.type !== 'file' || (hash !== null && hash === base.contentHash)
  const previous = ctx.store.entry(page.id)
  const local = found ? localOf(found, hash, ctx.now()) : null
  const entry = { ...entryFor(page, relPath, base, local, previous), state: agreed ? state : 'pending_upload' as const }
  await ctx.store.put(entry)
  if (found) ctx.scanner.written(relPath, found, hash)
  const text = baseBytes ?? (agreed ? bytes : null)
  if (keepText && found?.type === 'file' && text && sha256(text) === base.contentHash) {
    await ctx.store.setBase(page.id, { bytes: text, contentHash: base.contentHash! })
  } else if (state === 'synced' || !agreed) {
    await ctx.store.setBase(page.id, null)
  }
}

/** A8: verify, re-check the target, journal the install, rename, then record. */
export const runDownload = async (
  ctx: RunnerContext, action: Extract<ReconcileAction, { type: 'download' }>, actionId: string,
): Promise<void> => {
  const page = ctx.pages.get(action.pageId)
  if (!page) throw new FolderSyncLocalDriftError('The page is gone.')
  if (action.expect.local !== null && action.expect.local.contentHash === null) {
    throw new FolderSyncLocalDriftError('The plan never saw these bytes; they are not replaced.')
  }
  const part = await fetchVerified(ctx, action.pageId, action.versionId, action.contentHash, action.byteLength)
  const baseBytes = await baseTextOf(page, part)
  await installFile(ctx.teamDir, part, confinedPath(ctx.teamDir, action.relPath), {
    expectHash: action.expect.local?.contentHash ?? null,
    readOnly: action.readOnly,
    tag: actionId,
    beforeRename: () => ctx.store.install({
      actionId, pageId: action.pageId, versionId: action.versionId, revision: page.revision,
      hash: action.contentHash, relPath: action.relPath,
    }),
  })
  const revision = page.head?.versionId === action.versionId
    ? page.revision
    : ctx.store.entry(page.id)?.base.revision ?? 0
  await recordOnDisk(ctx, page, action.relPath, {
    versionId: action.versionId, revision, contentHash: action.contentHash,
  }, 'synced', baseBytes)
}

/** A verified version's bytes, read before they are installed, when they are kept as the merge base (A7). */
const baseTextOf = async (page: SyncPage, part: string): Promise<Uint8Array | undefined> =>
  keepsBaseText(page) ? new Uint8Array(await readFile(fsPath(part))) : undefined

/**
 * Every write answer lands here. `written`, `created` and `already_current`
 * move the base to the answer's head with the hash that was sent (A5) — the
 * file stays dirty if it moved on meanwhile. When the server stored other bytes
 * than were sent (a document's rendering, a re-encoded image; A11), the file is
 * rewritten with them only if it is still exactly what was sent, and the sent
 * bytes are kept in the local trash first. `remote_only`
 * leaves the bytes `preserved` and the head to be downloaded.
 */
export const afterWrite = async (
  ctx: RunnerContext, answer: FolderSyncPageResponse, sentHash: string, relPath: string,
  /** The action's journal id: names the hidden siblings of a replace so a replay can recover them. */
  tag?: string,
  /** The bytes that were sent, when held (a merge): they stay the merge base even if the file moved on. */
  sentBytes?: Uint8Array,
): Promise<void> => {
  const page = answer.page
  ctx.pages.set(page.id, page)
  ctx.gone.delete(page.id)
  ctx.ownRevisions.set(page.id, page.revision)
  const entry = ctx.store.entry(page.id)
  if (entry && entry.relPath !== relPath) {
    // A4: the canonical file's bytes went to its conflict's copy page. The copy
    // entry is left to download its new head; the canonical entry is preserved.
    const holder = ctx.store.entryAt(relPath)
    if (holder?.openConflict?.copyPageId === page.id) {
      await ctx.store.put({ ...holder, openConflict: { ...holder.openConflict, copyHash: sentHash }, state: 'preserved' })
    }
    ctx.replan()
    return
  }
  if (answer.outcome === 'remote_only') {
    if (entry) await ctx.store.put({ ...entry, state: 'preserved' })
    ctx.replan()
    return
  }
  const absolute = confinedPath(ctx.teamDir, relPath)
  const found = await lstatOrNull(absolute)
  const nowHash = found?.type === 'file' ? await hashFile(absolute) : null
  const head = page.head
  const base: SyncEntryBase = { versionId: head?.versionId ?? null, revision: page.revision, contentHash: sentHash }
  if (head && head.contentHash !== sentHash && nowHash === sentHash) {
    try {
      const part = await fetchVerified(ctx, page.id, head.versionId, head.contentHash, head.byteLength)
      const baseBytes = await baseTextOf(page, part)
      // Nessie keeps its rendering (re-encoded, metadata stripped, Markdown
      // re-written); the person's own bytes go to the trash, never nowhere.
      const kept = await keepFileCopyInTrash(ctx.paths.trash, ctx.teamDir, relPath, ctx.now())
      await recordTrashed(ctx.paths, relPath, kept, ctx.now(), ctx.security)
      await installFile(ctx.teamDir, part, absolute, {
        expectHash: sentHash, readOnly: page.readOnly, ...(tag ? { tag } : {}),
      })
      await recordOnDisk(ctx, page, relPath, { ...base, contentHash: head.contentHash }, 'synced', baseBytes)
      return
    } catch (error) {
      if (!(error instanceof FolderSyncLocalDriftError)) throw error
    }
  }
  await recordOnDisk(ctx, page, relPath, base, nowHash === sentHash ? 'synced' : 'pending_upload', sentBytes)
}

const baseRevisionFor = (ctx: RunnerContext, pageId: string, planned: number): number =>
  ctx.ownRevisions.get(pageId) ?? planned

export const runUpload = async (
  ctx: RunnerContext, action: Extract<ReconcileAction, { type: 'upload' }>, tag?: string,
): Promise<void> => {
  const absolute = confinedPath(ctx.teamDir, action.relPath)
  const baseRevision = baseRevisionFor(ctx, action.pageId, action.expect.base.revision)
  const answer = action.kind === 'document'
    ? await ctx.transport.writeDocument({
      operationKey: action.operationKey, pageId: action.pageId, baseRevision,
      baseVersionId: action.expect.base.versionId, markdown: await readDocument(absolute, action.expect.local),
      changeComment: action.changeComment,
    })
    : await withUploadSource(absolute, action.expect.local, (source) => ctx.transport.uploadFile({
      sessionKey: uploadSessionKey({ pageId: action.pageId }, source.expectedHash, action.operationKey),
      intent: {
        kind: 'new_version', operationKey: action.operationKey, pageId: action.pageId, baseRevision,
        baseVersionId: action.expect.base.versionId, changeComment: action.changeComment,
      },
      filename: baseName(action.relPath),
      mime: mimeFor(action.relPath),
    }, source))
  await afterWrite(ctx, answer, action.expect.local!.contentHash!, action.relPath, tag)
}

/** The page a pending parent stands for: made earlier this pass, or the folder entry at the parent path. */
export const resolveParent = (ctx: RunnerContext, parent: RemoteParent, relPath: string): string | null | undefined => {
  if (parent.type === 'existing') return parent.pageId
  const made = ctx.pageKeys.get(parent.pageKey)
  if (made) return made
  const folder = ctx.store.entryAt(parentPath(relPath))
  return folder?.kind === 'folder' ? folder.pageId : undefined
}

export const runCreate = async (
  ctx: RunnerContext, action: Extract<ReconcileAction, { type: 'createRemote' }>, tag?: string,
): Promise<void> => {
  const parentPageId = resolveParent(ctx, action.parent, action.relPath)
  if (parentPageId === undefined) throw new FolderSyncLocalDriftError('The parent folder was not created.')
  const absolute = confinedPath(ctx.teamDir, action.relPath)
  const placement = { pageKey: action.pageKey, spaceId: action.spaceId, parentPageId, title: action.title }
  let answer: FolderSyncPageResponse
  let sentHash: string | null = null
  if (action.kind === 'folder') {
    if (!await matchesExpected(absolute, action.expect.local)) throw new FolderSyncLocalDriftError('The folder moved.')
    answer = await ctx.transport.createPage({ ...placement, kind: 'folder' })
  } else if (action.kind === 'document') {
    const markdown = await readDocument(absolute, action.expect.local)
    sentHash = action.expect.local!.contentHash
    answer = await ctx.transport.createPage({ ...placement, kind: 'document', markdown })
  } else {
    answer = await withUploadSource(absolute, action.expect.local, (source) => {
      sentHash = source.expectedHash
      return ctx.transport.uploadFile({
        sessionKey: uploadSessionKey({ relPath: action.relPath }, source.expectedHash, action.pageKey),
        intent: { kind: 'new_page', ...placement },
        filename: baseName(action.relPath),
        mime: mimeFor(action.relPath),
      }, source)
    })
  }
  const page = answer.page
  ctx.pageKeys.set(action.pageKey, page.id)
  ctx.copiesCreated.set(action.relPath, page.id)
  const holder = ctx.store.entries().find((entry) => entry.openConflict?.copyRelPath === action.relPath)
  if (holder?.openConflict) {
    await ctx.store.put({ ...holder, openConflict: { ...holder.openConflict, copyPageId: page.id } })
  }
  if (action.kind === 'folder') {
    ctx.pages.set(page.id, page)
    ctx.ownRevisions.set(page.id, page.revision)
    await recordOnDisk(ctx, page, action.relPath, { versionId: null, revision: page.revision, contentHash: null })
  } else {
    await afterWrite(ctx, answer, sentHash!, action.relPath, tag)
  }
  // The entry this create replaces (its page is gone: C2, C5b) leaves with it,
  // not at the end of the pass: a crash in between would leave it to be
  // recreated a second time, and two entries naming one path.
  for (const other of ctx.store.entries()) {
    const replaced = other.pageId !== page.id && !ctx.pages.has(other.pageId)
    if (replaced && nameKey(other.relPath) === nameKey(action.relPath)) {
      await ctx.store.forget(other.pageId)
    }
  }
}

/**
 * R3: merge base, local and remote text. A clean merge is written here first
 * (over exactly the bytes the plan saw, the pre-merge text kept in the trash),
 * then sent as a new version of the head it merged; the base advances only
 * once the merged file re-hashes on disk. No base text, or any overlap, runs
 * the keep-both fallback instead. Answers whether it merged.
 */
export const runMerge = async (
  ctx: RunnerContext, action: Extract<ReconcileAction, { type: 'merge' }>, tag?: string,
): Promise<boolean> => {
  const entry = ctx.store.entry(action.pageId)
  const page = ctx.pages.get(action.pageId)
  if (!entry || !page?.head || page.head.versionId !== action.remoteVersionId) {
    throw new FolderSyncLocalDriftError('The head moved since the plan.')
  }
  const base = entry.base.contentHash ? await ctx.store.readBase(action.pageId, entry.base.contentHash) : null
  if (!base) return false
  const absolute = confinedPath(ctx.teamDir, action.relPath)
  const local = new Uint8Array(await readFile(fsPath(absolute)))
  if (sha256(local) !== action.expect.local?.contentHash) throw new FolderSyncLocalDriftError('The file changed.')
  const part = await fetchVerified(ctx, page.id, page.head.versionId, page.head.contentHash, page.head.byteLength)
  const remote = new Uint8Array(await readFile(fsPath(part)))
  const result = mergeText(base, local, remote)
  if (result.type !== 'merged') return false
  const kept = await keepCopyInTrash(ctx.paths.trash, action.relPath, local, ctx.now())
  await recordTrashed(ctx.paths, action.relPath, kept,
    ctx.now(), ctx.security)
  const staged = join(ctx.paths.pending, `${page.id}.merged`)
  await rm(fsPath(staged), { force: true })
  await writeNewFile(staged, result.bytes)
  await installFile(ctx.teamDir, staged, absolute, {
    expectHash: action.expect.local.contentHash, readOnly: false, ...(tag ? { tag } : {}),
  })
  const mergedHash = sha256(result.bytes)
  const baseRevision = baseRevisionFor(ctx, page.id, page.revision)
  const answer = entry.kind === 'document'
    ? await ctx.transport.writeDocument({
      operationKey: action.operationKey, pageId: page.id, baseRevision, baseVersionId: action.remoteVersionId,
      markdown: result.text, changeComment: action.changeComment,
    })
    : await ctx.transport.uploadFile({
      sessionKey: uploadSessionKey({ pageId: page.id }, mergedHash, action.operationKey),
      intent: {
        kind: 'new_version', operationKey: action.operationKey, pageId: page.id, baseRevision,
        baseVersionId: action.remoteVersionId, changeComment: action.changeComment,
      },
      filename: baseName(action.relPath),
      mime: mimeFor(action.relPath),
    }, memorySource(result.bytes, mergedHash))
  await rm(fsPath(part), { force: true })
  await afterWrite(ctx, answer, mergedHash, action.relPath, tag, result.bytes)
  return true
}

