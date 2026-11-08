import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'

import {
  EXECUTOR_FOLDER_SYNC_ENVELOPE_HEADER,
  EXECUTOR_FOLDER_SYNC_ERROR_CODES,
  EXECUTOR_FOLDER_SYNC_RETRYABLE_ERROR_CODES,
  EXECUTOR_FOLDER_SYNC_SIGNATURE_DOMAIN,
  EXECUTOR_FOLDER_SYNC_SIGNATURE_HEADER,
  FOLDER_SYNC_PART_BYTES,
  FOLDER_SYNC_TIMING,
  FolderSyncArchiveResponseSchema,
  FolderSyncChangesResponseSchema,
  FolderSyncConflictErrorDetailsSchema,
  FolderSyncHandshakeResponseSchema,
  FolderSyncPageResponseSchema,
  FolderSyncReportResponseSchema,
  FolderSyncSnapshotResponseSchema,
  FolderSyncUploadBeginResponseSchema,
  FolderSyncUploadPartResponseSchema,
  ExecutorPairingClaimSchema,
  canonicalExecutorJson,
  folderSyncPartByteLength,
  folderSyncPartCount,
  type ExecutorFolderSyncErrorCode,
  type FolderSyncArchiveRequest,
  type FolderSyncArchiveResponse,
  type FolderSyncChangesResponse,
  type FolderSyncConflictErrorDetails,
  type FolderSyncCreatePageRequest,
  type FolderSyncCursors,
  type FolderSyncHandshakeRequest,
  type FolderSyncHandshakeResponse,
  type FolderSyncMoveRequest,
  type FolderSyncOperation,
  type FolderSyncPageResponse,
  type FolderSyncReportRequest,
  type FolderSyncReportResponse,
  type FolderSyncSnapshotResponse,
  type FolderSyncUploadBeginRequest,
  type FolderSyncWriteDocumentRequest,
} from '@nessie/executor-protocol'

import { executorApi, ExecutorApiError, type ExecutorApiClient } from '../api-client.js'
import { signExecutorDaemonPayload } from '../daemon-signature.js'
import { pairingSignature } from '../pairing-code.js'
import { fsPath } from './local-fs.js'

/**
 * The daemon's signed sync calls (plan §4.3, `docs/standards/folder-sync.md`
 * → Wire). Every JSON body signs under the `sync` domain with its `operation`
 * inside the signed payload; the two byte routes carry the same envelope as
 * canonical JSON in a header. Answers are parsed with the shared schemas, so a
 * server that drifts from the contract fails here, loudly.
 */

/** What a request is signed with; read fresh per call, since a reclaim moves the epoch. */
export type FolderSyncConnection = {
  apiBaseUrl: string
  executorId: string
  connectionEpoch?: string
  machinePrivateKey: string
}

type Envelope = 'connectionEpoch' | 'executorId' | 'observedAt' | 'operation' | 'signature'
type Body<T> = T extends unknown ? Omit<T, Envelope> : never

export type FolderSyncUploadSource = {
  /** Read `length` bytes at `offset` of the file being sent. */
  read(offset: number, length: number): Promise<Uint8Array>
  byteLength: number
  /** What the plan saw: the upload aborts on a torn read rather than send other bytes (A5). */
  expectedHash: string
}

export type FolderSyncTransport = {
  /** Asks for the organisation's name too (`wantsOrganizationName`). */
  handshake(requested: FolderSyncHandshakeRequest['requested']): Promise<FolderSyncHandshakeResponse>
  /**
   * The team's and organisation's names from this computer's pairing claim —
   * the read the apps label teams with — for a Nessie whose handshake does not
   * name the organisation, and to show where files will go before it has run.
   */
  teamNames(): Promise<{ teamName: string | null; organizationName: string }>
  snapshot(cursor: string | null): Promise<FolderSyncSnapshotResponse>
  changes(cursors: FolderSyncCursors, wait: boolean, signal?: AbortSignal): Promise<FolderSyncChangesResponse>
  /** Fetch a version into `partPath`, resuming from what the part already holds. */
  download(pageId: string, versionId: string, partPath: string, byteLength: number): Promise<void>
  createPage(body: Body<FolderSyncCreatePageRequest>): Promise<FolderSyncPageResponse>
  writeDocument(body: Body<FolderSyncWriteDocumentRequest>): Promise<FolderSyncPageResponse>
  /** Begin (or resume) a session, send the missing parts, verify the whole file, complete. */
  uploadFile(
    begin: Omit<Body<FolderSyncUploadBeginRequest>, 'byteLength' | 'digest' | 'partCount'>,
    source: FolderSyncUploadSource,
  ): Promise<FolderSyncPageResponse>
  move(body: Body<FolderSyncMoveRequest>): Promise<FolderSyncPageResponse>
  archive(body: Body<FolderSyncArchiveRequest>): Promise<FolderSyncArchiveResponse>
  report(body: Body<FolderSyncReportRequest>): Promise<FolderSyncReportResponse>
}

/** A sync route's refusal, with the error envelope's code and details. */
export const syncErrorCode = (error: unknown): ExecutorFolderSyncErrorCode | string | null =>
  error instanceof ExecutorApiError ? error.code ?? null : null

/** True for the 403 `EXECUTOR_FOLDER_SYNC_READ_ONLY` that refuses a move into another space. */
export const refusedAsOtherSpace = (error: unknown): boolean =>
  error instanceof ExecutorApiError && error.code === EXECUTOR_FOLDER_SYNC_ERROR_CODES.READ_ONLY
  && (error.details as { reason?: unknown } | undefined)?.reason === 'other_space'

/** A 409 `EXECUTOR_FOLDER_SYNC_CONFLICT`'s head and reason, or null. */
export const conflictDetails = (error: unknown): FolderSyncConflictErrorDetails | null => {
  if (!(error instanceof ExecutorApiError) || error.code !== EXECUTOR_FOLDER_SYNC_ERROR_CODES.CONFLICT) return null
  const parsed = FolderSyncConflictErrorDetailsSchema.safeParse(error.details)
  return parsed.success ? parsed.data : null
}

/**
 * True when the failure says nothing about this request — the network, a
 * timeout, a 5xx, a retryable code, any 429: back off and try the pass again.
 * A 429 counts whatever its code: the API's per-IP limiter answers the generic
 * `RATE_LIMITED` before the sync routes run, and treating that as an action
 * failure re-planned at once and hammered the limiter for its whole window.
 */
export const isTransientSyncError = (error: unknown): boolean => {
  if (!(error instanceof ExecutorApiError)) return error instanceof TypeError
  const retryable = EXECUTOR_FOLDER_SYNC_RETRYABLE_ERROR_CODES as readonly string[]
  if ((error.code !== undefined && retryable.includes(error.code)) || error.status === 429) {
    return true
  }
  if (error.code === 'EXECUTOR_API_TIMEOUT' || error.code === 'EXECUTOR_API_CANCELLED') return true
  return error.code === undefined || (error.status !== undefined && error.status >= 500)
}

const SYNC = '/api/executor-daemon/sync'
const LONG_POLL_TIMEOUT_MS = FOLDER_SYNC_TIMING.longPollMs + 10_000
const transferTimeoutMs = (bytes: number): number => 60_000 + Math.ceil(bytes / 64)

export const createFolderSyncTransport = (
  connection: () => FolderSyncConnection,
  api: Pick<ExecutorApiClient, 'pairing' | 'syncGetBytes' | 'syncPost' | 'syncPutBytes'> = executorApi,
): FolderSyncTransport => {
  const envelope = (operation: FolderSyncOperation) => {
    const live = connection()
    if (!live.connectionEpoch) throw new Error('Executor has not claimed a live daemon connection.')
    return {
      live,
      fields: {
        connectionEpoch: live.connectionEpoch,
        executorId: live.executorId,
        observedAt: new Date().toISOString(),
        operation,
      },
    }
  }
  const signed = async <T>(
    operation: FolderSyncOperation, path: string, body: object,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> => {
    const { live, fields } = envelope(operation)
    const payload = { ...fields, ...body }
    const signature = signExecutorDaemonPayload(live.machinePrivateKey, EXECUTOR_FOLDER_SYNC_SIGNATURE_DOMAIN, payload)
    return api.syncPost<T>(live.apiBaseUrl, `${SYNC}${path}`, { ...payload, signature }, options)
  }
  const headers = (operation: FolderSyncOperation, ids: Record<string, string | number>) => {
    const { live, fields } = envelope(operation)
    const payload = { ...fields, ...ids }
    return {
      live,
      headers: {
        [EXECUTOR_FOLDER_SYNC_ENVELOPE_HEADER]: canonicalExecutorJson(payload),
        [EXECUTOR_FOLDER_SYNC_SIGNATURE_HEADER]: signExecutorDaemonPayload(
          live.machinePrivateKey, EXECUTOR_FOLDER_SYNC_SIGNATURE_DOMAIN, payload,
        ),
      },
    }
  }

  const uploadFile: FolderSyncTransport['uploadFile'] = async (begin, source) => {
    const partCount = folderSyncPartCount(source.byteLength)
    const session = FolderSyncUploadBeginResponseSchema.parse(await signed('upload_begin', '/uploads', {
      ...begin, byteLength: source.byteLength, digest: source.expectedHash, partCount,
    }))
    const received = new Set(session.partsReceived)
    const whole = createHash('sha256')
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const length = folderSyncPartByteLength(source.byteLength, partNumber)
      const bytes = await source.read((partNumber - 1) * FOLDER_SYNC_PART_BYTES, length)
      if (bytes.length !== length) throw new TornReadError()
      whole.update(bytes)
      if (received.has(partNumber)) continue
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      const { live, headers: envelopeHeaders } = headers('upload_part', {
        uploadId: session.uploadId, partNumber, byteLength: length, digest,
      })
      FolderSyncUploadPartResponseSchema.parse(await api.syncPutBytes(
        live.apiBaseUrl, `${SYNC}/uploads/${session.uploadId}/parts/${partNumber}`, envelopeHeaders, bytes,
        { timeoutMs: transferTimeoutMs(length) },
      ))
    }
    if (`sha256:${whole.digest('hex')}` !== source.expectedHash) throw new TornReadError()
    return FolderSyncPageResponseSchema.parse(await signed('upload_complete', `/uploads/${session.uploadId}/complete`, {
      uploadId: session.uploadId,
    }, { timeoutMs: transferTimeoutMs(source.byteLength) }))
  }

  return {
    handshake: async (requested) => FolderSyncHandshakeResponseSchema.parse(
      await signed('handshake', '/handshake', { requested, wantsOrganizationName: true }),
    ),
    teamNames: async () => {
      const live = connection()
      const payload = { executorId: live.executorId, timestamp: new Date().toISOString() }
      const claim = ExecutorPairingClaimSchema.parse(await api.pairing(live.apiBaseUrl, 'connection', {
        ...payload, signature: pairingSignature(live.machinePrivateKey, 'connection', payload),
      }))
      return { teamName: claim.team?.name ?? null, organizationName: claim.organization.name }
    },
    snapshot: async (cursor) =>
      FolderSyncSnapshotResponseSchema.parse(await signed('snapshot', '/snapshot', { cursor })),
    changes: async (cursors, wait, signal) => FolderSyncChangesResponseSchema.parse(await signed(
      'changes', '/changes', { cursors, wait }, { signal, ...(wait ? { timeoutMs: LONG_POLL_TIMEOUT_MS } : {}) },
    )),
    download: async (pageId, versionId, partPath, byteLength) => {
      const found = await stat(fsPath(partPath)).catch(() => null)
      // A part that already holds every byte (an install refused after the
      // fetch, A8) is not asked for again: `bytes=<length>-` is a 416, which
      // failed every later pass. The caller's hash check decides. A part longer
      // than the version is not this version's and starts over.
      if (found !== null && found.size === byteLength) return
      const resumeAt = found !== null && found.size < byteLength ? found.size : 0
      const { live, headers: envelopeHeaders } = headers('download', { pageId, versionId })
      const answer = await api.syncGetBytes(live.apiBaseUrl, `${SYNC}/pages/${pageId}/versions/${versionId}/bytes`, {
        ...envelopeHeaders, ...(resumeAt > 0 ? { range: `bytes=${resumeAt}-` } : {}),
      }, { timeoutMs: transferTimeoutMs(byteLength) })
      // A server that ignored the range answered the whole file: start over.
      // Opened `w` to start over rather than truncated: Windows refuses to
      // truncate a handle opened for appending (EPERM).
      const offset = answer.status === 206 ? resumeAt : 0
      const handle = await open(fsPath(partPath), offset > 0 ? 'r+' : 'w', 0o600)
      try {
        let position = offset
        if (answer.body) {
          for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
            await handle.write(chunk, 0, chunk.length, position)
            position += chunk.length
          }
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
    },
    createPage: async (body) => FolderSyncPageResponseSchema.parse(await signed('create_page', '/pages', body)),
    writeDocument: async (body) => FolderSyncPageResponseSchema.parse(
      await signed('write_document', `/pages/${body.pageId}/document`, body),
    ),
    uploadFile,
    move: async (body) => FolderSyncPageResponseSchema.parse(await signed('move', `/pages/${body.pageId}/move`, body)),
    archive: async (body) => FolderSyncArchiveResponseSchema.parse(
      await signed('archive', `/pages/${body.pageId}/archive`, body),
    ),
    report: async (body) => FolderSyncReportResponseSchema.parse(await signed('report', '/report', body)),
  }
}

/** The file changed while it was being sent: abort, re-hash, replan (A5). */
export class TornReadError extends Error {
  constructor() {
    super('The file changed while it was being uploaded.')
  }
}
