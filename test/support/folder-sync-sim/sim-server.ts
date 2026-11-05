import { generateKeyPairSync, randomUUID } from 'node:crypto'

import type { SyncPage } from '@nessie/executor-protocol'

import { FolderSyncFakeServer, sha, type FakePage, type FakeVersion } from '../folder-sync-fake-server.js'
import { Refusal, handleFakeSyncRequest } from '../folder-sync-fake-routes.js'

/**
 * One Nessie shared by several computers. Each computer talks to its own
 * *view*: an object whose prototype is the shared server, so pages, versions
 * and the journal are one store, while the executor identity, the receipts,
 * the upload sessions, the conflict rows, the faults and the offline switch
 * are the computer's own — as the real server scopes receipts, sessions and
 * conflict rows by executor.
 *
 * The server also audits what the daemons do (A12.11): a canonical write by a
 * daemon must follow a passing base/lifecycle guard on that page at that
 * revision; a move must keep the parent graph a tree; a create must land under
 * a live folder of its space. Every daemon effect is recorded so the oracles
 * can prove one effect per logical operation.
 */

export type SimEffect = {
  executorId: string
  kind: 'create' | 'version' | 'move' | 'archive'
  pageId: string
  pageKind: SyncPage['kind']
  contentHash: string | null
  spaceId: string
  parentPageId: string | null
  title: string
}

export type SimAudit = {
  guarded: { pageId: string; revision: number } | null
  creating: boolean
  violations: string[]
  effects: SimEffect[]
  /** Version id → the hash its bytes had when stored (versions are immutable). */
  versionHashes: Map<string, string>
}

const PRIVATE_CLOCK = 'clock'

export class SimServer extends FolderSyncFakeServer {
  readonly audit: SimAudit = { guarded: null, creating: false, violations: [], effects: [], versionHashes: new Map() }
  /** Executor id → the computer's label, for messages. */
  readonly labels = new Map<string, string>()

  /** A computer's own view of this server (see the class comment). */
  view(label: string): FolderSyncFakeServer {
    const keys = generateKeyPairSync('ed25519')
    const view = Object.create(this) as FolderSyncFakeServer
    const own: Record<string, unknown> = {
      executorId: randomUUID(),
      publicKey: keys.publicKey,
      machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      offline: false,
      faults: [],
      conflicts: new Map(),
      reports: [],
      calls: [],
      receipts: new Map(),
      uploads: new Map(),
      instructions: { heldDeletes: null, resolveConflicts: [] },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        handleFakeSyncRequest(view, new Request(input, init)),
    }
    for (const [key, value] of Object.entries(own)) {
      Object.defineProperty(view, key, { value, writable: true, enumerable: true, configurable: true })
    }
    const shared = this as unknown as Record<string, number>
    Object.defineProperty(view, PRIVATE_CLOCK, {
      get: () => shared[PRIVATE_CLOCK], set: (value: number) => { shared[PRIVATE_CLOCK] = value }, configurable: true,
    })
    this.labels.set(view.executorId, label)
    return view
  }

  private violation(message: string): void {
    this.audit.violations.push(message)
  }

  private requireGuard(page: FakePage, executorId: string, what: string): void {
    const guarded = this.audit.guarded
    if (!guarded || guarded.pageId !== page.id || guarded.revision !== page.revision) {
      this.violation(`${this.labels.get(executorId) ?? executorId}: ${what} of "${page.title}" without a passing base guard`)
    }
    this.audit.guarded = null
  }

  private effect(executorId: string | null, kind: SimEffect['kind'], page: FakePage, contentHash: string | null): void {
    if (executorId === null) return
    this.audit.effects.push({
      executorId, kind, pageId: page.id, pageKind: page.kind, contentHash,
      spaceId: page.spaceId, parentPageId: page.parentPageId, title: page.title,
    })
  }

  override guard(page: FakePage | undefined, baseRevision: number, baseVersionId?: string | null) {
    const refusal = super.guard(page, baseRevision, baseVersionId)
    this.audit.guarded = refusal === null && page ? { pageId: page.id, revision: page.revision } : null
    return refusal
  }

  override addVersion(page: FakePage, bytes: Uint8Array, name: string, executorId: string | null): FakeVersion {
    if (executorId !== null && !this.audit.creating) this.requireGuard(page, executorId, 'a new version')
    const version = super.addVersion(page, bytes, name, executorId)
    this.audit.versionHashes.set(version.versionId, version.contentHash)
    if (!this.audit.creating) this.effect(executorId, 'version', page, version.contentHash)
    return version
  }

  override createPageRecord(
    input: Parameters<FolderSyncFakeServer['createPageRecord']>[0], executorId: string | null,
  ): FakePage {
    if (executorId !== null) {
      const parent = input.parentPageId === null ? null : this.pages.get(input.parentPageId)
      const spaceLive = this.spaces.some((space) => space.id === input.spaceId)
      const parentLive = input.parentPageId === null
        || (parent !== undefined && parent !== null && parent.status === 'live' && parent.kind === 'folder'
          && parent.spaceId === input.spaceId)
      if (!spaceLive || !parentLive) throw new Refusal(404, 'EXECUTOR_FOLDER_SYNC_NOT_FOUND')
    }
    this.audit.creating = true
    let page: FakePage
    try {
      page = super.createPageRecord(input, executorId)
    } finally {
      this.audit.creating = false
    }
    this.effect(executorId, 'create', page, this.head(page)?.contentHash ?? null)
    return page
  }

  override moveRecord(
    page: FakePage, to: { parentPageId: string | null; spaceId: string; title: string }, executorId: string | null,
  ): void {
    if (executorId !== null) {
      this.requireGuard(page, executorId, 'a move')
      const parent = to.parentPageId === null ? null : this.pages.get(to.parentPageId)
      const cycle = parent
        ? parent.id === page.id || this.descendants(page.id).some((child) => child.id === parent.id)
        : false
      const parentLive = to.parentPageId === null
        || (parent !== undefined && parent !== null && parent.status === 'live' && parent.kind === 'folder'
          && parent.spaceId === to.spaceId)
      if (cycle || !parentLive || !this.spaces.some((space) => space.id === to.spaceId)) {
        // As T2's `assertMoveDoesNotCycle` and lifecycle checks: the tree stays a tree.
        throw new Refusal(409, 'EXECUTOR_FOLDER_SYNC_CONFLICT', { page: this.project(page), reason: 'subtree_changed' })
      }
    }
    super.moveRecord(page, to, executorId)
    this.effect(executorId, 'move', page, null)
  }

  override archiveRecord(page: FakePage, executorId: string | null): string[] {
    if (executorId !== null) this.requireGuard(page, executorId, 'an archive')
    const archived = super.archiveRecord(page, executorId)
    this.effect(executorId, 'archive', page, null)
    return archived
  }

  /** Every content hash Nessie holds in any version of any page, archived ones included. */
  heldHashes(): Set<string> {
    const held = new Set<string>()
    for (const page of this.pages.values()) for (const version of page.versions) held.add(version.contentHash)
    return held
  }

  /** Versions whose bytes no longer hash to what was stored. */
  mutatedVersions(): string[] {
    const mutated: string[] = []
    for (const page of this.pages.values()) {
      for (const version of page.versions) {
        const stored = this.audit.versionHashes.get(version.versionId) ?? version.contentHash
        if (sha(version.bytes) !== stored || version.contentHash !== stored) mutated.push(`${page.title}@${version.versionId}`)
      }
    }
    return mutated
  }
}
