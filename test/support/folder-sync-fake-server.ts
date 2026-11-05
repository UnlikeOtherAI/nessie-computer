import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'

import {
  SyncPageSchema,
  type ConflictReport,
  type FolderSyncConflictErrorReason,
  type FolderSyncConflictResolution,
  type FolderSyncRecordStatus,
  type FolderSyncReportRequest,
  type FolderSyncReportResponse,
  type JournalRow,
  type SyncExcludedSpace,
  type SyncPage,
  type SyncSpace,
} from '@nessie/executor-protocol'

import { handleFakeSyncRequest } from './folder-sync-fake-routes.js'

/**
 * An in-process Nessie for folder sync tests, faithful to the T0 wire: every
 * request is parsed with its strict schema and its signature verified against
 * the machine key; every write is a revision CAS, receipted by its operation
 * key (A2) or page key; every change is a journal row with a per-space
 * sequence; every answer is parsed with its schema before it is returned.
 *
 * Tests drive it two ways: as the daemon's server (`fetch`, handed to the
 * executor API client) and as "another person" editing Nessie (`actor`), whose
 * writes carry no executor id and so are never the daemon's echo. The T8
 * simulator builds on the same class.
 */

export type FakeVersion = {
  versionId: string; bytes: Uint8Array; contentHash: string; mime: string; extension: string | null
}

export type FakePage = {
  id: string
  spaceId: string
  parentPageId: string | null
  kind: SyncPage['kind']
  title: string
  revision: number
  createdAt: string
  status: 'live' | 'archived'
  archiveOperationId: string | null
  readOnlyReason: SyncPage['readOnlyReason']
  /** A document whose Markdown cannot hold its formatting (`lossy`). */
  lossy: boolean
  versions: FakeVersion[]
}

export type FakeUpload = {
  uploadId: string
  sessionKey: string
  request: Record<string, unknown>
  parts: Map<number, Uint8Array>
  completed: unknown | null
}

/** A fault for the next matching request: refuse it, or do it and lose the answer. */
/** A conflict row as the real server keeps it (`executor_folder_sync_conflicts`). */
export type FakeConflictRow = ConflictReport & {
  state: 'open' | 'resolving' | 'resolved'
  resolution: FolderSyncConflictResolution | null
}

export type FakeFault ={ operation: string; mode: 'refuse'; status: number; code: string } | { operation: string; mode: 'lose_answer' }

export const sha = (bytes: Uint8Array | string): string =>
  `sha256:${createHash('sha256').update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).digest('hex')}`

const encoder = new TextEncoder()
const extensionOf = (name: string): string | null => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null
}

export class FolderSyncFakeServer {
  readonly executorId = randomUUID()
  readonly publicKey: KeyObject
  /** The executor's machine key, as `ExecutorLocalState.machinePrivateKey` holds it. */
  readonly machinePrivateKey: string
  readonly connectionEpoch = '1'
  readonly apiBaseUrl = 'https://nessie.test'
  status: FolderSyncRecordStatus = 'live'
  teamLabel = 'UnlikeOtherAI'
  /** The computer's label as Nessie shows it, which the handshake names. */
  computerLabel = 'Laptop'
  maxUploadBytes = 5 * 1024 * 1024 * 1024
  snapshotPageSize = 500
  spaces: SyncSpace[] = []
  excludedSpaces: SyncExcludedSpace[] = []
  readonly pages = new Map<string, FakePage>()
  readonly journal: Array<JournalRow & { seqNumber: number }> = []
  /** Operation, page and session receipts: key → request digest and answer. */
  readonly receipts = new Map<string, { digest: string; answer: unknown }>()
  readonly uploads = new Map<string, FakeUpload>()
  readonly conflicts = new Map<string, FakeConflictRow>()
  readonly reports: FolderSyncReportRequest[] = []
  readonly calls: string[] = []
  /**
   * Instructions for the next report answer only, on top of the relay of the
   * rows in `resolving`: lets a test hand the daemon a choice the real resolve
   * route would refuse (a stale `expectedOccurredAt`).
   */
  instructions: FolderSyncReportResponse['instructions'] = { heldDeletes: null, resolveConflicts: [] }
  faults: FakeFault[] = []
  /** Every request fails as a network error, as if the computer were offline. */
  offline = false
  /** How Nessie re-renders stored Markdown (A11): identity by default. */
  render: (markdown: string) => string = (markdown) => markdown
  /** How Nessie stores uploaded file bytes (images are re-encoded, A11): identity by default. */
  storeFile: (bytes: Uint8Array, filename: string) => Uint8Array = (bytes) => bytes
  private clock = Date.parse('2026-11-03T09:00:00.000Z')

  constructor() {
    const keys = generateKeyPairSync('ed25519')
    this.publicKey = keys.publicKey
    this.machinePrivateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  }

  /** What the daemon's `connection()` reads. */
  connection() {
    return {
      apiBaseUrl: this.apiBaseUrl, executorId: this.executorId,
      connectionEpoch: this.connectionEpoch, machinePrivateKey: this.machinePrivateKey,
    }
  }

  /** The executor API client's `fetch`. */
  readonly fetch: typeof fetch = async (input, init) => handleFakeSyncRequest(this, new Request(input, init))

  tick(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }

  /**
   * The person's choice in Nessie, as T7's resolve route takes it
   * (`resolveFolderSyncConflict`): only on an open row whose `occurredAt` is
   * the one they saw. Dismiss closes the row; Keep mine / Keep Nessie's mark
   * it `resolving`, and every report answer relays it until the daemon
   * reports it resolved or re-reports it with a new `occurredAt`.
   */
  resolveInNessie(
    clientConflictId: string, resolution: FolderSyncConflictResolution, expectedOccurredAt: string,
  ): boolean {
    const row = this.conflicts.get(clientConflictId)
    if (!row || row.state !== 'open' || row.occurredAt !== expectedOccurredAt) return false
    this.conflicts.set(clientConflictId, { ...row, state: resolution === 'dismiss' ? 'resolved' : 'resolving', resolution })
    return true
  }

  // ── Projections ─────────────────────────────────────────────────────────────

  head(page: FakePage): FakeVersion | null {
    return page.versions[page.versions.length - 1] ?? null
  }

  project(page: FakePage): SyncPage {
    const head = page.kind === 'folder' ? null : this.head(page)
    const space = this.spaces.find((candidate) => candidate.id === page.spaceId)
    const readOnlyReason = page.kind === 'spreadsheet' ? 'spreadsheet'
      : page.lossy ? 'document_formatting'
        : page.readOnlyReason ?? (space && !space.writable ? 'no_write_access' : null)
    return SyncPageSchema.parse({
      id: page.id,
      spaceId: page.spaceId,
      parentPageId: page.parentPageId,
      kind: page.kind,
      title: page.title,
      revision: page.revision,
      createdAt: page.createdAt,
      head: head ? {
        versionId: head.versionId, contentHash: head.contentHash, byteLength: head.bytes.length,
        mime: head.mime, extension: head.extension,
      } : null,
      readOnly: readOnlyReason !== null,
      readOnlyReason,
      fidelity: page.kind === 'spreadsheet' ? 'oneway' : page.lossy ? 'lossy' : 'exact',
      notSyncedReason: page.kind !== 'folder' && !head ? 'no_content_yet' : null,
    })
  }

  livePages(): FakePage[] {
    const mirrored = new Set(this.spaces.map((space) => space.id))
    return [...this.pages.values()].filter((page) => page.status === 'live' && mirrored.has(page.spaceId))
  }

  /** The live page at a title path (`Space/Folder/Title`), or undefined. */
  find(path: string): FakePage | undefined {
    const [spaceName, ...titles] = path.split('/')
    const space = this.spaces.find((candidate) => candidate.name === spaceName)
    let parent: string | null = null
    let found: FakePage | undefined
    for (const title of titles) {
      found = this.livePages()
        .find((page) => page.spaceId === space?.id && page.parentPageId === parent && page.title === title)
      if (!found) return undefined
      parent = found.id
    }
    return found
  }

  text(page: FakePage | undefined): string | null {
    const head = page ? this.head(page) : null
    return head ? Buffer.from(head.bytes).toString('utf8') : null
  }

  // ── The journal ─────────────────────────────────────────────────────────────

  record(row: Omit<JournalRow, 'seq' | 'createdAt' | 'actorExecutorId'>, executorId: string | null): void {
    const seqNumber = this.journal.length + 1
    this.journal.push({
      ...row, seq: String(seqNumber), seqNumber, createdAt: this.tick(), actorExecutorId: executorId,
    })
  }

  cursorOf(spaceId: string): string {
    const rows = this.journal.filter((row) => row.spaceId === spaceId)
    return rows.length === 0 ? '0' : rows[rows.length - 1]!.seq
  }

  // ── Writes, shared by the routes and the actor ─────────────────────────────

  addVersion(page: FakePage, bytes: Uint8Array, name: string, executorId: string | null): FakeVersion {
    const version: FakeVersion = {
      versionId: randomUUID(), bytes, contentHash: sha(bytes),
      mime: page.kind === 'document' ? 'text/markdown' : page.kind === 'spreadsheet'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream',
      extension: page.kind === 'document' ? 'md' : page.kind === 'spreadsheet' ? 'xlsx' : extensionOf(name),
    }
    page.versions.push(version)
    page.revision += 1
    this.record({
      spaceId: page.spaceId, pageId: page.id, kind: 'version_created', versionId: version.versionId,
      revision: page.revision, parentPageId: page.parentPageId, title: page.title,
    }, executorId)
    return version
  }

  createPageRecord(input: {
    spaceId: string; parentPageId: string | null; kind: SyncPage['kind']; title: string
    content?: Uint8Array | string; lossy?: boolean; readOnlyReason?: SyncPage['readOnlyReason']
  }, executorId: string | null): FakePage {
    const page: FakePage = {
      id: randomUUID(), spaceId: input.spaceId, parentPageId: input.parentPageId, kind: input.kind, title: input.title,
      revision: 0, createdAt: this.tick(), status: 'live', archiveOperationId: null,
      readOnlyReason: input.readOnlyReason ?? null, lossy: input.lossy ?? false, versions: [],
    }
    this.pages.set(page.id, page)
    this.record({
      spaceId: page.spaceId, pageId: page.id, kind: 'page_created', versionId: null, revision: 0,
      parentPageId: page.parentPageId, title: page.title,
    }, executorId)
    if (input.content !== undefined && input.kind !== 'folder') {
      const bytes = typeof input.content === 'string' ? encoder.encode(input.content) : input.content
      this.addVersion(page, bytes, input.title, executorId)
    }
    return page
  }

  /** Live descendants of a page. */
  descendants(pageId: string): FakePage[] {
    const found: FakePage[] = []
    const visit = (id: string) => {
      for (const page of this.pages.values()) {
        if (page.parentPageId === id && page.status === 'live') {
          found.push(page)
          visit(page.id)
        }
      }
    }
    visit(pageId)
    return found
  }

  archiveRecord(page: FakePage, executorId: string | null): string[] {
    const operationId = randomUUID()
    const subtree = [page, ...this.descendants(page.id)]
    for (const each of subtree) {
      each.status = 'archived'
      each.archiveOperationId = operationId
      each.revision += 1
    }
    this.record({
      spaceId: page.spaceId, pageId: page.id, kind: 'page_archived', versionId: null, revision: page.revision,
      parentPageId: page.parentPageId, title: page.title,
    }, executorId)
    return subtree.map((each) => each.id)
  }

  moveRecord(
    page: FakePage, to: { parentPageId: string | null; spaceId: string; title: string }, executorId: string | null,
  ) {
    const renamed = page.title !== to.title && page.parentPageId === to.parentPageId && page.spaceId === to.spaceId
    page.parentPageId = to.parentPageId
    page.title = to.title
    if (page.spaceId !== to.spaceId) {
      for (const each of [page, ...this.descendants(page.id)]) each.spaceId = to.spaceId
    }
    page.revision += 1
    this.record({
      spaceId: page.spaceId, pageId: page.id, kind: renamed ? 'page_renamed' : 'page_moved', versionId: null,
      revision: page.revision, parentPageId: page.parentPageId, title: page.title,
    }, executorId)
  }

  /** The CAS of every conditional write, in the order T2 checks it (A1, A12.1). */
  guard(page: FakePage | undefined, baseRevision: number, baseVersionId?: string | null):
    { status: number; code: string; reason?: FolderSyncConflictErrorReason } | null {
    if (!page || page.status !== 'live') return { status: 404, code: 'EXECUTOR_FOLDER_SYNC_NOT_FOUND' }
    if (baseVersionId !== undefined) {
      const known = baseVersionId === null
        ? page.versions.length === 0
        : page.versions.some((v) => v.versionId === baseVersionId)
      if (!known) return { status: 409, code: 'EXECUTOR_FOLDER_SYNC_CONFLICT', reason: 'base_unknown' }
    }
    if (page.revision !== baseRevision) {
      return { status: 409, code: 'EXECUTOR_FOLDER_SYNC_CONFLICT', reason: page.archiveOperationId ? 'lifecycle_changed' : 'head_changed' }
    }
    return null
  }

  // ── Another person in Nessie ────────────────────────────────────────────────

  readonly actor = {
    space: (name: string, overrides: Partial<SyncSpace> = {}): SyncSpace => {
      const space: SyncSpace = { id: randomUUID(), name, personal: false, sensitivity: 'normal', writable: true, ...overrides }
      this.spaces.push(space)
      return space
    },
    create: (input: Parameters<FolderSyncFakeServer['createPageRecord']>[0]): FakePage => this.createPageRecord(input, null),
    edit: (pageId: string, content: string | Uint8Array): void => {
      const page = this.pages.get(pageId)!
      this.addVersion(page, typeof content === 'string' ? encoder.encode(content) : content, page.title, null)
    },
    rename: (pageId: string, title: string): void => {
      const page = this.pages.get(pageId)!
      this.moveRecord(page, { parentPageId: page.parentPageId, spaceId: page.spaceId, title }, null)
    },
    move: (pageId: string, parentPageId: string | null, spaceId?: string): void => {
      const page = this.pages.get(pageId)!
      this.moveRecord(page, { parentPageId, spaceId: spaceId ?? page.spaceId, title: page.title }, null)
    },
    archive: (pageId: string): void => { this.archiveRecord(this.pages.get(pageId)!, null) },
  }
}
