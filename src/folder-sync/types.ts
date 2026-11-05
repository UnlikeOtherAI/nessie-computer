import type {
  ConflictReport,
  ExecutorFolderSyncErrorCode,
  FolderSyncConflictReason,
  FolderSyncEntryState,
  FolderSyncFidelity,
  FolderSyncPageKind,
  FolderSyncReadOnlyReason,
} from '@nessie/executor-protocol'

/**
 * The folder sync engine's own types: the index entry the reconciler works
 * on and the actions it plans. The wire and the shared vocabulary live in
 * `@nessie/executor-protocol` (`executor-folder-sync*.ts`); the standard is
 * `docs/standards/folder-sync.md`.
 *
 * Every hash is `sha256:<64 hex>`, the form the server's `contentHash` uses.
 * Every path is a `FolderSyncRelPath`: relative to the team folder, forward
 * slashes, mapped by `path-mapping.ts`.
 */

export type {
  ConflictReport,
  FolderSyncConflictReason,
  FolderSyncEntryState,
  FolderSyncFidelity,
  FolderSyncPageKind,
  FolderSyncReadOnlyReason,
}

/** What both sides last agreed on. Decisions compare against it, never time. */
export type SyncEntryBase = {
  versionId: string | null
  revision: number
  contentHash: string | null
}

/** The file as the last scan saw it. */
export type SyncEntryLocal = {
  /** `String(ino)` with `dev`, from `fs.stat(path, { bigint: true })`. */
  fileId: string | null
  size: number
  mtimeMs: number
  contentHash: string | null
  seenAt: number
}

/** The page as the server last described it. */
export type SyncEntryRemote = {
  versionId: string | null
  revision: number
  contentHash: string | null
  readOnly: boolean
  /** Which R1 reason a local edit is quarantined for; null when writable. */
  readOnlyReason: FolderSyncReadOnlyReason | null
  fidelity: FolderSyncFidelity
}

/** Why an entry is not `synced`: a row reason, a server code, or a local wait. */
export type SyncEntryDetailCode =
  | FolderSyncConflictReason
  | ExecutorFolderSyncErrorCode
  | 'not_stable'
  | 'transport_failed'

export type SyncEntryDetail = {
  code: SyncEntryDetailCode
  /** Local console text; never content, never sent upstream. */
  message: string
  retryAt?: number
}

/**
 * The conflict row an entry has open (amendment A4). While it is open, further
 * local divergence of the canonical file goes to the copy page as new
 * versions, never into a second copy. The copy's name is allocated once and
 * stored here before the copy is made, so a retry never renames it. Cleared
 * when the row is resolved; a later save then targets the canonical page.
 */
export type SyncEntryOpenConflict = {
  clientConflictId: string
  /** The sibling page R2 created; null until its `createRemote` succeeded. */
  copyPageId: string | null
  copyRelPath: string
  /** The hash of the bytes the copy holds (the last generation sent to it). */
  copyHash: string | null
}

/** The reconciler's unit: one page and its file. */
export type SyncEntry = {
  pageId: string
  spaceId: string
  kind: FolderSyncPageKind
  /** The mapped path at base. */
  relPath: string
  parentPageId: string | null
  title: string
  base: SyncEntryBase
  local: SyncEntryLocal | null
  remote: SyncEntryRemote | null
  state: FolderSyncEntryState
  detail?: SyncEntryDetail
  /** Set while a conflict row for this entry is open (A4). */
  openConflict?: SyncEntryOpenConflict | null
}

/** The local side of an entry, against its base. */
export type LocalChange = 'same' | 'modified' | 'deleted' | 'created' | 'moved'

/** The remote side of an entry, against its base. */
export type RemoteChange =
  | 'same'
  | 'modified'
  | 'deleted'
  | 'created'
  | 'moved'
  | 'access_lost'
  | 'readonly_now'

/** The local file as the plan saw it. */
export type ExpectedLocal = {
  fileId: string | null
  contentHash: string | null
}

/**
 * What an action's precondition is. The code that carries out an action
 * re-checks it — the file still hashes to `local.contentHash`, the server
 * still answers `base.revision` — and drops the action back to planning on
 * any drift. `local: null` means the path must still be absent.
 */
export type ActionExpectation = {
  base: SyncEntryBase | null
  local: ExpectedLocal | null
}

/** An expectation for an action on a page both sides already know. */
export type BasedExpectation = ActionExpectation & { base: SyncEntryBase }

/**
 * Where a page goes: an existing page (null = the space root), or a page an
 * earlier `createRemote` in the same plan creates, named by its `pageKey`.
 */
export type RemoteParent =
  | { type: 'existing'; pageId: string | null }
  | { type: 'pending'; pageKey: string }

/**
 * One step of a plan. Actions on the same page or path run in list order;
 * independent ones may run concurrently (`FOLDER_SYNC_CONCURRENCY`).
 */
export type ReconcileAction =
  /** Fetch `versionId` into `relPath` via `pending/`, verify, rename into place. */
  | {
    type: 'download'
    pageId: string
    versionId: string
    relPath: string
    contentHash: string
    byteLength: number
    /** Set the OS read-only attribute (a read-only mirror). */
    readOnly: boolean
    expect: ActionExpectation
  }
  /** Send the file at `relPath` as a new version of `pageId`. */
  | {
    type: 'upload'
    pageId: string
    /**
     * The write's receipt key (amendment A2): derived from the page, the
     * base revision and the content, so a retry or a re-plan of the same
     * write reuses it and a lost response replays instead of conflicting.
     */
    operationKey: string
    relPath: string
    kind: 'document' | 'file'
    changeComment: string
    expect: BasedExpectation
  }
  /** Create a page from a local item; `pageKey` makes a retry idempotent. */
  | {
    type: 'createRemote'
    pageKey: string
    relPath: string
    kind: 'folder' | 'document' | 'file'
    spaceId: string
    parent: RemoteParent
    title: string
    expect: ActionExpectation & { base: null }
  }
  /** Move and/or rename a page to match a local move. */
  | {
    type: 'moveRemote'
    pageId: string
    /** The write's receipt key (A2), as on `upload`. */
    operationKey: string
    fromRelPath: string
    toRelPath: string
    spaceId: string
    parent: RemoteParent
    title: string
    expect: BasedExpectation
  }
  /** Archive a page (and its subtree) without purging its bytes. */
  | {
    type: 'archiveRemote'
    pageId: string
    /** The write's receipt key (A2), as on `upload`. */
    operationKey: string
    relPath: string
    /** Set when a person released this delete from a held batch. */
    heldDeleteBatchId: string | null
    /** Live descendants the manifest knows; the server refuses a changed subtree (A12.6). */
    descendantCount: number
    descendantHash: string
    expect: BasedExpectation
  }
  /** Move a local item: a remote rename, or a clash moved aside (C7). */
  | {
    type: 'moveLocal'
    pageId: string | null
    fromRelPath: string
    toRelPath: string
    expect: ActionExpectation
  }
  /** Move a local item to the state directory's `trash/`. */
  | {
    type: 'trashLocal'
    pageId: string | null
    relPath: string
    expect: ActionExpectation
  }
  | {
    type: 'mkdir'
    pageId: string
    relPath: string
  }
  /**
   * A three-way text merge (R3) over the base version, the local file and the
   * remote head. A clean merge is uploaded as `upload` would; any overlapping
   * hunk runs `fallback` instead.
   */
  | {
    type: 'merge'
    pageId: string
    /** The write's receipt key (A2), as on `upload`. */
    operationKey: string
    relPath: string
    baseVersionId: string
    remoteVersionId: string
    changeComment: string
    expect: BasedExpectation
    fallback: ConflictCopyAction
  }
  /** R1: move a local edit of a read-only page aside; it is never uploaded. */
  | {
    type: 'quarantine'
    pageId: string
    relPath: string
    copyRelPath: string
    reason: Extract<
      FolderSyncConflictReason,
      | 'read_only_document_formatting'
      | 'read_only_spreadsheet'
      | 'read_only_published'
      | 'read_only_no_write_access'
    >
    expect: ActionExpectation
  }
  | ConflictCopyAction
  /** The brake held this archive until a person decides. */
  | {
    type: 'holdDelete'
    pageId: string
    relPath: string
    batchId: string
  }
  /** Tell the person once (R7): upsert the row in the next report. */
  | {
    type: 'recordConflict'
    conflict: ConflictReport
  }
  /** C6 with identical bytes: link the local file to the page, no transfer. */
  | {
    type: 'adopt'
    pageId: string
    relPath: string
    base: SyncEntryBase
  }
  /**
   * No I/O: drop the entry. Its page is gone or replaced (C2 recreates it as
   * a new page) and its file is gone, trashed, or about to be re-tracked.
   */
  | {
    type: 'forgetEntry'
    pageId: string
    relPath: string
  }
  /** No I/O: the entry waits, failed, or is held, with why. */
  | {
    type: 'setEntryState'
    pageId: string
    state: FolderSyncEntryState
    detail: SyncEntryDetail | null
  }
  /**
   * Keep mine (A4): the conflicted copy's bytes replace the canonical file at
   * `relPath`, which must still hold `canonicalHash`. Never planned: the
   * person's resolution journals it, so a crash inside the replace is put
   * right (and the replace finished) by the replay.
   */
  | KeepMineAction

/**
 * R2: the local version moves to its conflicted-copy name so the server head
 * can take the canonical path. The sibling page in Nessie is a following
 * `createRemote` of `copyRelPath`, and the head a following `download`.
 */
export type ConflictCopyAction = {
  type: 'conflictCopy'
  pageId: string | null
  relPath: string
  copyRelPath: string
  reason: Extract<FolderSyncConflictReason, 'edited_on_both_sides' | 'created_on_both_sides'>
  expect: ActionExpectation
}

export type KeepMineAction = {
  type: 'keepMine'
  pageId: string | null
  relPath: string
  copyRelPath: string
  expect: { canonicalHash: string | null; copyHash: string }
}
