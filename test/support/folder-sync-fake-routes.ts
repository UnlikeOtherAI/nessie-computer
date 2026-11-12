import { randomUUID, verify } from 'node:crypto'

import {
  EXECUTOR_FOLDER_SYNC_ENVELOPE_HEADER,
  EXECUTOR_FOLDER_SYNC_SIGNATURE_CONTEXT,
  EXECUTOR_FOLDER_SYNC_SIGNATURE_HEADER,
  FOLDER_SYNC_MARKDOWN_MAX_BYTES,
  FOLDER_SYNC_PART_BYTES,
  FOLDER_SYNC_SPACE_JOURNAL_KINDS,
  FolderSyncArchiveRequestSchema,
  FolderSyncArchiveResponseSchema,
  FolderSyncChangesRequestSchema,
  FolderSyncChangesResponseSchema,
  FolderSyncCreatePageRequestSchema,
  FolderSyncDownloadEnvelopeSchema,
  FolderSyncHandshakeRequestSchema,
  FolderSyncHandshakeResponseSchema,
  FolderSyncMoveRequestSchema,
  FolderSyncReportRequestSchema,
  FolderSyncReportResponseSchema,
  FolderSyncSnapshotRequestSchema,
  FolderSyncSnapshotResponseSchema,
  FolderSyncUploadBeginRequestSchema,
  FolderSyncUploadBeginResponseSchema,
  FolderSyncUploadCompleteRequestSchema,
  FolderSyncUploadPartEnvelopeSchema,
  FolderSyncUploadPartResponseSchema,
  FolderSyncWriteDocumentRequestSchema,
  ExecutorPairingClaimSchema,
  ExecutorPairingConnectionRequestSchema,
  canonicalExecutorJson,
  canonicalFolderSyncDescendantRevisions,
  canonicalExecutorPayload,
  folderSyncDownloadEtag,
  folderSyncPartByteLength,
  type FolderSyncPageResponse,
  type FolderSyncUploadIntent,
} from '@nessie/executor-protocol'
import type { ZodType } from 'zod'

import { sha, type FakePage, type FolderSyncFakeServer } from './folder-sync-fake-server.js'

/** The fake's HTTP surface: `/api/executor-daemon/sync/*`, as T2 serves it. */

/** A refusal in the error envelope; exported so a subclassed fake (the simulator) refuses the same way. */
export class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, readonly details?: unknown) {
    super(code)
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const verified = (server: FolderSyncFakeServer, payload: Record<string, unknown>, signature: unknown): void => {
  if (typeof signature !== 'string' || !verify(
    null, Buffer.from(canonicalExecutorPayload(EXECUTOR_FOLDER_SYNC_SIGNATURE_CONTEXT, payload)),
    server.publicKey, Buffer.from(signature, 'base64url'),
  )) throw new Refusal(401, 'EXECUTOR_SIGNATURE_INVALID')
  if (payload.executorId !== server.executorId || payload.connectionEpoch !== server.connectionEpoch) {
    throw new Refusal(409, 'EXECUTOR_CONNECTION_FENCED')
  }
}

const parseSigned = <T extends { signature: string }>(
  server: FolderSyncFakeServer, schema: ZodType<T>, body: unknown,
): T => {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new Refusal(400, 'VALIDATION_ERROR', parsed.error.issues)
  const { signature, ...payload } = parsed.data
  verified(server, payload, signature)
  return parsed.data
}

const parseEnvelope = <T>(server: FolderSyncFakeServer, schema: ZodType<T>, request: Request): T => {
  const header = request.headers.get(EXECUTOR_FOLDER_SYNC_ENVELOPE_HEADER)
  let parsed: ReturnType<ZodType<T>['safeParse']>
  try {
    parsed = schema.safeParse(JSON.parse(header ?? ''))
  } catch {
    throw new Refusal(400, 'EXECUTOR_FOLDER_SYNC_ENVELOPE_INVALID')
  }
  if (!parsed.success || canonicalExecutorJson(parsed.data) !== header) {
    throw new Refusal(400, 'EXECUTOR_FOLDER_SYNC_ENVELOPE_INVALID')
  }
  verified(server, parsed.data as Record<string, unknown>, request.headers.get(EXECUTOR_FOLDER_SYNC_SIGNATURE_HEADER))
  return parsed.data
}

const requestDigest = (body: Record<string, unknown>): string => {
  const rest = { ...body }
  for (const key of ['signature', 'connectionEpoch', 'observedAt']) delete rest[key]
  return sha(canonicalExecutorJson(rest))
}

/** A2: same key and digest replays the answer; same key, other digest is a mismatch. */
const receipted = <T>(server: FolderSyncFakeServer, key: string | undefined, digest: string, write: () => T): T => {
  if (key === undefined) throw new Refusal(400, 'VALIDATION_ERROR')
  const found = server.receipts.get(key)
  if (found) {
    if (found.digest !== digest) throw new Refusal(409, 'EXECUTOR_FOLDER_SYNC_OPERATION_MISMATCH')
    return found.answer as T
  }
  const answer = write()
  server.receipts.set(key, { digest, answer })
  return answer
}

const writable = (server: FolderSyncFakeServer, page: FakePage): void => {
  if (server.project(page).readOnly) throw new Refusal(403, 'EXECUTOR_FOLDER_SYNC_READ_ONLY')
}

const guarded = (
  server: FolderSyncFakeServer, page: FakePage | undefined, baseRevision: number, baseVersionId?: string | null,
) => {
  const refusal = server.guard(page, baseRevision, baseVersionId)
  if (!refusal) return page!
  const details = refusal.reason ? { page: server.project(page!), reason: refusal.reason } : undefined
  throw new Refusal(refusal.status, refusal.code, details)
}

/**
 * A3: decide by hash before writing — the head's bytes, the base's bytes, or a
 * new version. The hash is decided before the revision CAS (C33, C36): a save
 * of the head or of the old base from a stale revision is no write, and no 409;
 * only new bytes must name the current revision.
 */
const contentWrite = (
  server: FolderSyncFakeServer, page: FakePage, baseRevision: number, baseVersionId: string | null,
  bytes: Uint8Array, name: string,
): FolderSyncPageResponse => {
  const hash = sha(bytes)
  const head = server.head(page)
  if (head?.contentHash === hash) return { outcome: 'already_current', page: server.project(page) }
  const base = page.versions.find((version) => version.versionId === baseVersionId)
  if (base && head && base.versionId !== head.versionId && base.contentHash === hash) {
    return { outcome: 'remote_only', page: server.project(page) }
  }
  guarded(server, page, baseRevision, baseVersionId)
  server.addVersion(page, bytes, name, server.executorId)
  return { outcome: 'written', page: server.project(page) }
}

const markdownBytes = (server: FolderSyncFakeServer, markdown: string): Uint8Array =>
  new TextEncoder().encode(server.render(markdown))

const createWithKey = (
  server: FolderSyncFakeServer, pageKey: string, digest: string, create: () => FakePage,
): FolderSyncPageResponse => receipted(server, `page:${pageKey}`, digest, () => ({ outcome: 'created' as const, page: server.project(create()) }))

const completeUpload = (server: FolderSyncFakeServer, uploadId: string): FolderSyncPageResponse => {
  const upload = server.uploads.get(uploadId)
  if (!upload) throw new Refusal(410, 'EXECUTOR_FOLDER_SYNC_UPLOAD_EXPIRED')
  if (upload.completed) return upload.completed as FolderSyncPageResponse
  const request = upload.request as {
    byteLength: number; digest: string; partCount: number; filename: string; intent: FolderSyncUploadIntent
  }
  const parts: Uint8Array[] = []
  for (let n = 1; n <= request.partCount; n += 1) {
    const part = upload.parts.get(n)
    if (!part) throw new Refusal(400, 'EXECUTOR_FOLDER_SYNC_UPLOAD_INVALID')
    parts.push(part)
  }
  const bytes = new Uint8Array(Buffer.concat(parts))
  if (bytes.length !== request.byteLength || sha(bytes) !== request.digest) {
    throw new Refusal(400, 'EXECUTOR_FOLDER_SYNC_UPLOAD_INVALID')
  }
  const stored = server.storeFile(bytes, request.filename)
  const intent = request.intent
  const digest = sha(canonicalExecutorJson({ intent, digest: request.digest, byteLength: request.byteLength }))
  const answer = intent.kind === 'new_page'
    ? createWithKey(server, intent.pageKey, digest, () => server.createPageRecord({
      spaceId: intent.spaceId, parentPageId: intent.parentPageId, kind: 'file', title: intent.title, content: stored,
    }, server.executorId))
    : receipted(server, intent.operationKey, digest, () => {
      const found = server.pages.get(intent.pageId)
      const page = guarded(server, found, found?.revision ?? intent.baseRevision, intent.baseVersionId)
      writable(server, page)
      return contentWrite(server, page, intent.baseRevision, intent.baseVersionId, stored, request.filename)
    })
  upload.completed = answer
  return answer
}

type Handler = (server: FolderSyncFakeServer, body: Record<string, unknown>, match: RegExpMatchArray) => unknown

const routes: Array<{ method: string; path: RegExp; operation: string; handle: Handler }> = [
  // The pairing claim (`/api/executor-pairing/connection`), signed under its own domain: the names it carries.
  { method: 'POST', path: /\/executor-pairing\/connection$/u, operation: 'pairing_connection', handle: (server, body) => {
    const { signature, ...payload } = ExecutorPairingConnectionRequestSchema.parse(body)
    if (!verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.pairing.connection.v1', payload)),
      server.publicKey, Buffer.from(signature, 'base64url'))) throw new Refusal(401, 'EXECUTOR_SIGNATURE_INVALID')
    return ExecutorPairingClaimSchema.parse({
      executorId: server.executorId, machineName: server.computerLabel,
      organization: { id: 'org-1', name: server.organizationName }, team: { id: 'team-1', name: server.teamLabel },
      scope: { kind: 'private', organizationId: '00000000-0000-4000-8000-0000000000aa' }, claimDigest: `sha256:${'0'.repeat(64)}`,
    })
  } },
  { method: 'POST', path: /\/handshake$/u, operation: 'handshake', handle: (server, body) => {
    if (server.handshakeRefusesOrganizationName && 'wantsOrganizationName' in body) {
      // What Nessie's strict request parsing answers for a key it does not know.
      server.organizationNameRefusals += 1
      throw new Refusal(400, 'VALIDATION_ERROR',
        [{ code: 'unrecognized_keys', keys: ['wantsOrganizationName'], path: [], message: 'Unrecognized key(s) in object' }])
    }
    const request = parseSigned(server, FolderSyncHandshakeRequestSchema, body)
    const named = request.wantsOrganizationName && server.handshakeNamesOrganization
    return FolderSyncHandshakeResponseSchema.parse({
      status: server.status, teamLabel: server.teamLabel,
      ...(named ? { organizationName: server.organizationName } : {}),
      computerLabel: server.computerLabel, includeSensitive: true,
      manageUrl: `https://unlikeotherai.nessie.test/team/computers/${server.executorId}?tab=sync`,
      limits: {
        maxUploadBytes: server.maxUploadBytes, partBytes: FOLDER_SYNC_PART_BYTES,
        markdownMaxBytes: FOLDER_SYNC_MARKDOWN_MAX_BYTES,
      },
      retentionFloorSeq: '0',
    })
  } },
  { method: 'POST', path: /\/snapshot$/u, operation: 'snapshot', handle: (server, body) => {
    const request = parseSigned(server, FolderSyncSnapshotRequestSchema, body)
    const offset = request.cursor === null ? 0 : Number(request.cursor)
    const pages = server.livePages().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const slice = pages.slice(offset, offset + server.snapshotPageSize)
    const next = offset + slice.length < pages.length ? String(offset + slice.length) : null
    return FolderSyncSnapshotResponseSchema.parse({
      spaces: server.spaces, excludedSpaces: server.excludedSpaces, pages: slice.map((page) => server.project(page)),
      cursors: Object.fromEntries(server.spaces.map((space) => [space.id, server.cursorOf(space.id)])),
      nextCursor: next,
    })
  } },
  { method: 'POST', path: /\/changes$/u, operation: 'changes', handle: (server, body) => {
    const request = parseSigned(server, FolderSyncChangesRequestSchema, body)
    const rows = server.journal.filter((row) => row.seqNumber > Number(request.cursors[row.spaceId] ?? '0'))
    const named = new Set(rows.map((row) => row.pageId).filter((id): id is string => id !== null))
    const live = new Set(server.livePages().map((page) => page.id))
    const cursors = { ...request.cursors }
    for (const space of server.spaces) cursors[space.id] = server.cursorOf(space.id)
    return FolderSyncChangesResponseSchema.parse({
      changes: rows.map(({ seqNumber: _n, ...row }) => row),
      pages: [...named].filter((id) => live.has(id)).map((id) => server.project(server.pages.get(id)!)),
      gonePageIds: [...named].filter((id) => !live.has(id)),
      // A space-wide row (renamed, archived, access changed) sends the client to a snapshot.
      cursors, hasMore: false, cursorExpired: [],
      spacesChanged: rows.some((row) => (FOLDER_SYNC_SPACE_JOURNAL_KINDS as readonly string[]).includes(row.kind)),
    })
  } },
  { method: 'POST', path: /\/pages$/u, operation: 'create_page', handle: (server, body) => {
    const request = parseSigned(server, FolderSyncCreatePageRequestSchema, body)
    return createWithKey(server, request.pageKey, requestDigest(body), () => server.createPageRecord({
      spaceId: request.spaceId, parentPageId: request.parentPageId, kind: request.kind, title: request.title,
      ...(request.kind === 'document' ? { content: markdownBytes(server, request.markdown) } : {}),
    }, server.executorId))
  } },
  { method: 'POST', path: /\/pages\/([^/]+)\/document$/u, operation: 'write_document', handle: (server, body) => {
    const request = parseSigned(server, FolderSyncWriteDocumentRequestSchema, body)
    return receipted(server, request.operationKey, requestDigest(body), () => {
      const found = server.pages.get(request.pageId)
      const page = guarded(server, found, found?.revision ?? request.baseRevision, request.baseVersionId)
      writable(server, page)
      const bytes = markdownBytes(server, request.markdown)
      return contentWrite(server, page, request.baseRevision, request.baseVersionId, bytes, page.title)
    })
  } },
  { method: 'POST', path: /\/uploads$/u, operation: 'upload_begin', handle: (server, body) => {
    const request = parseSigned(server, FolderSyncUploadBeginRequestSchema, body)
    if (request.byteLength > server.maxUploadBytes) throw new Refusal(413, 'EXECUTOR_FOLDER_SYNC_TOO_LARGE')
    let upload = [...server.uploads.values()].find((candidate) => candidate.sessionKey === request.sessionKey)
    // As `beginFolderSyncUpload`: a session key names one upload (intent, name, type, size, digest).
    const shape = (body: typeof request) => canonicalExecutorJson({
      intent: body.intent, filename: body.filename, mime: body.mime, byteLength: body.byteLength, digest: body.digest,
    })
    if (upload && shape(upload.request as typeof request) !== shape(request)) {
      throw new Refusal(409, 'EXECUTOR_FOLDER_SYNC_OPERATION_MISMATCH')
    }
    if (!upload) {
      upload = { uploadId: randomUUID(), sessionKey: request.sessionKey, request, parts: new Map(), completed: null }
      server.uploads.set(upload.uploadId, upload)
    }
    return FolderSyncUploadBeginResponseSchema.parse({
      uploadId: upload.uploadId, partCount: request.partCount,
      partsReceived: [...upload.parts.keys()].sort((a, b) => a - b),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })
  } },
  { method: 'POST', path: /\/uploads\/([^/]+)\/complete$/u, operation: 'upload_complete', handle: (server, body) => {
    const request = parseSigned(server, FolderSyncUploadCompleteRequestSchema, body)
    return completeUpload(server, request.uploadId)
  } },
  { method: 'POST', path: /\/pages\/([^/]+)\/move$/u, operation: 'move', handle: (server, body) => {
    const request = parseSigned(server, FolderSyncMoveRequestSchema, body)
    return receipted(server, request.operationKey, requestDigest(body), () => {
      const page = guarded(server, server.pages.get(request.pageId), request.baseRevision)
      // As `moveFolderSyncPage`: a page changes space only by Nessie's own transfer.
      if (request.spaceId !== page.spaceId) throw new Refusal(403, 'EXECUTOR_FOLDER_SYNC_READ_ONLY', { reason: 'other_space' })
      const to = { parentPageId: request.parentPageId, spaceId: request.spaceId, title: request.title }
      server.moveRecord(page, to, server.executorId)
      return { outcome: 'written' as const, page: server.project(page) }
    })
  } },
  { method: 'POST', path: /\/pages\/([^/]+)\/archive$/u, operation: 'archive', handle: (server, body) => {
    const request = parseSigned(server, FolderSyncArchiveRequestSchema, body)
    return receipted(server, request.operationKey, requestDigest(body), () => {
      const page = guarded(server, server.pages.get(request.pageId), request.baseRevision)
      const descendants = server.descendants(page.id)
      if (request.descendantCount !== descendants.length
        || request.descendantHash !== sha(canonicalFolderSyncDescendantRevisions(descendants))) {
        throw new Refusal(409, 'EXECUTOR_FOLDER_SYNC_CONFLICT', { page: server.project(page), reason: 'subtree_changed' })
      }
      return FolderSyncArchiveResponseSchema.parse({ archivedPageIds: server.archiveRecord(page, server.executorId) })
    })
  } },
  { method: 'POST', path: /\/report$/u, operation: 'report', handle: (server, body) => {
    const request = parseSigned(server, FolderSyncReportRequestSchema, body)
    server.reports.push(request)
    // As `reportFolderSync`: a row is upserted; the same `occurredAt` changes
    // nothing, a new one reopens it (C32); a reported resolution closes it.
    for (const conflict of request.conflicts) {
      const existing = server.conflicts.get(conflict.clientConflictId)
      if (existing?.occurredAt === conflict.occurredAt) continue
      server.conflicts.set(conflict.clientConflictId, { ...conflict, state: 'open', resolution: null })
    }
    for (const resolved of request.resolved) {
      const row = server.conflicts.get(resolved.clientConflictId)
      if (row) server.conflicts.set(resolved.clientConflictId, { ...row, state: 'resolved', resolution: resolved.resolution })
    }
    // Every row still `resolving` is relayed, in every answer, until it settles.
    const relayed = [...server.conflicts.values()]
      .filter((row) => row.state === 'resolving' && (row.resolution === 'keep_mine' || row.resolution === 'keep_nessie'))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
      .map((row) => ({
        clientConflictId: row.clientConflictId,
        resolution: row.resolution as 'keep_mine' | 'keep_nessie',
        expectedOccurredAt: row.occurredAt,
      }))
    const instructions = {
      heldDeletes: server.instructions.heldDeletes,
      resolveConflicts: [...relayed, ...server.instructions.resolveConflicts],
    }
    const answer = FolderSyncReportResponseSchema.parse({ status: server.status, instructions })
    server.instructions = { heldDeletes: null, resolveConflicts: [] }
    return answer
  } },
]

const bytesRoute = async (server: FolderSyncFakeServer, request: Request, path: string): Promise<Response | null> => {
  const download = path.match(/\/pages\/([^/]+)\/versions\/([^/]+)\/bytes$/u)
  if (request.method === 'GET' && download) {
    server.calls.push('download')
    const envelope = parseEnvelope(server, FolderSyncDownloadEnvelopeSchema, request)
    if (envelope.pageId !== download[1] || envelope.versionId !== download[2]) throw new Refusal(400, 'EXECUTOR_FOLDER_SYNC_ENVELOPE_INVALID')
    const page = server.pages.get(envelope.pageId)
    const version = page?.status === 'live' ? page.versions.find((v) => v.versionId === envelope.versionId) : undefined
    if (!version) throw new Refusal(404, 'EXECUTOR_FOLDER_SYNC_NOT_FOUND')
    const range = request.headers.get('range')?.match(/^bytes=(\d+)-$/u)
    const start = range ? Number(range[1]) : 0
    // As the real route (`parseByteRange`): a range starting at or past the end is a bodiless 416.
    if (range && start >= version.bytes.length) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${version.bytes.length}` } })
    }
    return new Response(version.bytes.slice(start), {
      status: range ? 206 : 200,
      headers: { etag: folderSyncDownloadEtag(version.versionId, version.contentHash) },
    })
  }
  const part = path.match(/\/uploads\/([^/]+)\/parts\/(\d+)$/u)
  if (request.method === 'PUT' && part) {
    server.calls.push('upload_part')
    const envelope = parseEnvelope(server, FolderSyncUploadPartEnvelopeSchema, request)
    const upload = server.uploads.get(envelope.uploadId)
    if (!upload || envelope.uploadId !== part[1] || envelope.partNumber !== Number(part[2])) {
      throw new Refusal(410, 'EXECUTOR_FOLDER_SYNC_UPLOAD_EXPIRED')
    }
    const bytes = new Uint8Array(await request.arrayBuffer())
    const total = (upload.request as { byteLength: number }).byteLength
    const expected = folderSyncPartByteLength(total, envelope.partNumber)
    if (bytes.length !== envelope.byteLength || bytes.length !== expected || sha(bytes) !== envelope.digest) {
      throw new Refusal(400, 'EXECUTOR_FOLDER_SYNC_UPLOAD_INVALID')
    }
    upload.parts.set(envelope.partNumber, bytes)
    const partsReceived = [...upload.parts.keys()].sort((a, b) => a - b)
    return json(200, { data: FolderSyncUploadPartResponseSchema.parse({ partsReceived }) })
  }
  return null
}

const takeFault = (server: FolderSyncFakeServer, operation: string) => {
  const index = server.faults.findIndex((candidate) => candidate.operation === operation)
  return index >= 0 ? server.faults.splice(index, 1)[0]! : null
}

export const handleFakeSyncRequest = async (server: FolderSyncFakeServer, request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname
  if (server.offline) throw new TypeError('fetch failed')
  try {
    const byteOperation = request.method === 'GET' ? 'download' : request.method === 'PUT' ? 'upload_part' : null
    const byteFault = byteOperation ? takeFault(server, byteOperation) : null
    if (byteFault?.mode === 'refuse') return json(byteFault.status, { error: { code: byteFault.code, message: byteFault.code } })
    const bytes = await bytesRoute(server, request, path)
    if (byteFault?.mode === 'lose_answer') throw new TypeError('fetch failed')
    if (bytes) return bytes
    const route = routes.find((candidate) => candidate.method === request.method && candidate.path.test(path))
    if (!route) return json(404, { error: { code: 'NOT_FOUND', message: path } })
    server.calls.push(route.operation)
    const planned = takeFault(server, route.operation)
    if (planned?.mode === 'refuse') return json(planned.status, { error: { code: planned.code, message: planned.code } })
    const data = route.handle(server, await request.json() as Record<string, unknown>, path.match(route.path)!)
    if (planned?.mode === 'lose_answer') throw new TypeError('fetch failed')
    return json(200, { data })
  } catch (error) {
    if (error instanceof Refusal) {
      const details = error.details ? { details: error.details } : {}
      return json(error.status, { error: { code: error.code, message: error.code, ...details } })
    }
    throw error
  }
}

