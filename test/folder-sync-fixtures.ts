import { createHash } from 'node:crypto'

import type { SyncPage, SyncSpace } from '@nessie/executor-protocol'

import { mapTree } from '../src/folder-sync/path-mapping.js'
import type { LocalScanItem, ReconcileInput, ReconcilePlan } from '../src/folder-sync/reconcile-model.js'
import { reconcile } from '../src/folder-sync/reconciler.js'
import type { ReconcileAction, SyncEntry } from '../src/folder-sync/types.js'

/** Builders for reconciler tests: a synced world, then whatever each case changes. */

export const NOW = 10_000_000
export const SPACE_ID = '10000000-0000-4000-8000-000000000001'
export const OTHER_SPACE_ID = '10000000-0000-4000-8000-000000000002'
export const space = (overrides: Partial<SyncSpace> = {}): SyncSpace => ({
  id: SPACE_ID, name: 'Space', personal: false, sensitivity: 'normal', writable: true, ...overrides,
})

export const hash = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`
export const uuid = (prefix: string, n: number): string => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
export const pageId = (n: number) => uuid('20000000', n)
export const versionId = (n: number) => uuid('30000000', n)

export type PageSpec = {
  n: number
  title: string
  kind?: SyncPage['kind']
  parent?: number | null
  spaceId?: string
  revision?: number
  version?: number
  content?: string
  readOnlyReason?: SyncPage['readOnlyReason']
  mime?: string
  extension?: string | null
  createdAt?: string
}

export const page = (spec: PageSpec): SyncPage => {
  const kind = spec.kind ?? 'document'
  const readOnlyReason = spec.readOnlyReason ?? (kind === 'spreadsheet' ? 'spreadsheet' : null)
  const content = spec.content ?? `content of ${spec.title}`
  return {
    id: pageId(spec.n),
    spaceId: spec.spaceId ?? SPACE_ID,
    parentPageId: spec.parent ? pageId(spec.parent) : null,
    kind,
    title: spec.title,
    revision: spec.revision ?? 1,
    createdAt: spec.createdAt ?? `2026-01-01T00:00:${String(spec.n % 60).padStart(2, '0')}.000Z`,
    head: kind === 'folder' ? null : {
      versionId: versionId(spec.version ?? spec.n),
      contentHash: hash(content),
      byteLength: content.length,
      mime: spec.mime ?? (kind === 'document' ? 'text/markdown' : kind === 'spreadsheet' ? 'application/vnd.ms-excel' : 'text/plain'),
      extension: spec.extension === undefined ? (kind === 'document' ? 'md' : kind === 'spreadsheet' ? 'xlsx' : 'txt')
        : spec.extension,
    },
    readOnly: readOnlyReason !== null,
    readOnlyReason,
    fidelity: kind === 'spreadsheet' ? 'oneway' : readOnlyReason === 'document_formatting' ? 'lossy' : 'exact',
    notSyncedReason: null,
  }
}

export const fileItem = (relPath: string, content: string, overrides: Partial<LocalScanItem> = {}): LocalScanItem => ({
  relPath, type: 'file', fileId: `file:${relPath}`, size: content.length, mtimeMs: 5, contentHash: hash(content),
  stableSinceMs: 0, unopenableSinceMs: null, ...overrides,
})
export const dirItem = (relPath: string, overrides: Partial<LocalScanItem> = {}): LocalScanItem => ({
  relPath, type: 'directory', fileId: `dir:${relPath}`, size: 0, mtimeMs: 5, contentHash: null,
  stableSinceMs: 0, unopenableSinceMs: null, ...overrides,
})

export type World = { spaces: SyncSpace[]; pages: SyncPage[]; entries: SyncEntry[]; items: LocalScanItem[] }

/** Every page downloaded and agreed: entries at their mapped paths, files on disk with the head's bytes. */
export const syncedWorld = (specs: PageSpec[], spaces: SyncSpace[] = [space()]): World => {
  const pages = specs.map(page)
  const mapping = mapTree(spaces, pages)
  const contentOf = new Map(specs.map((spec) => [pageId(spec.n), spec.content ?? `content of ${spec.title}`]))
  const entries = pages.map((p): SyncEntry => {
    const relPath = mapping.paths.get(p.id)!
    const item = p.kind === 'folder' ? dirItem(relPath) : fileItem(relPath, contentOf.get(p.id)!)
    return {
      pageId: p.id,
      spaceId: p.spaceId,
      kind: p.kind,
      relPath,
      parentPageId: p.parentPageId,
      title: p.title,
      base: { versionId: p.head?.versionId ?? null, revision: p.revision, contentHash: p.head?.contentHash ?? null },
      local: { fileId: item.fileId, size: item.size, mtimeMs: item.mtimeMs, contentHash: item.contentHash, seenAt: 0 },
      remote: {
        versionId: p.head?.versionId ?? null, revision: p.revision, contentHash: p.head?.contentHash ?? null,
        readOnly: p.readOnly, readOnlyReason: p.readOnlyReason, fidelity: p.fidelity,
      },
      state: 'synced',
    }
  })
  const items = [
    ...[...mapping.spaceDirs.values()].map((dir) => dirItem(dir)),
    ...entries.map((e) => (e.kind === 'folder' ? dirItem(e.relPath) : fileItem(e.relPath, contentOf.get(e.pageId)!))),
  ]
  return { spaces, pages, entries, items }
}

export type RunOptions = Partial<Omit<ReconcileInput, 'remote' | 'local' | 'entries'>> & {
  rootPresent?: boolean
  teamFolderPresent?: boolean
  scope?: readonly string[] | null
  excludedSpaceIds?: string[]
}

export const run = (world: World, options: RunOptions = {}): ReconcilePlan => reconcile({
  now: NOW,
  passId: '50000000-0000-4000-8000-000000000001',
  computerLabel: 'Laptop',
  utcOffsetMinutes: 0,
  maxUploadBytes: 5 * 1024 * 1024 * 1024,
  knownConflictIds: new Set(),
  mergeBases: new Set(),
  heldDecision: null,
  ...options,
  entries: world.entries,
  local: {
    rootPresent: options.rootPresent ?? true,
    teamFolderPresent: options.teamFolderPresent ?? true,
    scope: options.scope ?? null,
    items: world.items,
  },
  remote: {
    snapshotAt: '2026-11-03T00:00:00.000Z',
    spaces: world.spaces,
    excludedSpaceIds: options.excludedSpaceIds ?? [],
    pages: world.pages,
  },
})

// ── Mutations ────────────────────────────────────────────────────────────────

export const editLocal = (world: World, relPath: string, content: string, overrides: Partial<LocalScanItem> = {}) => {
  world.items = world.items.map((item) => (item.relPath === relPath
    ? { ...fileItem(relPath, content), fileId: item.fileId, mtimeMs: 99, ...overrides }
    : item))
}
export const deleteLocal = (world: World, relPath: string) => {
  world.items = world.items.filter((item) => item.relPath !== relPath && !item.relPath.startsWith(`${relPath}/`))
}
export const moveLocalItem = (world: World, from: string, to: string) => {
  world.items = world.items.map((item) => (item.relPath === from || item.relPath.startsWith(`${from}/`)
    ? { ...item, relPath: `${to}${item.relPath.slice(from.length)}` }
    : item))
}
export const addLocal = (world: World, item: LocalScanItem) => { world.items = [...world.items, item] }
export const editRemote = (world: World, n: number, content: string, version: number, revision?: number) => {
  world.pages = world.pages.map((p) => (p.id === pageId(n) ? {
    ...p,
    revision: revision ?? p.revision + 1,
    head: { ...p.head!, versionId: versionId(version), contentHash: hash(content), byteLength: content.length },
  } : p))
}
export const updateRemote = (world: World, n: number, change: Partial<SyncPage>) => {
  world.pages = world.pages.map((p) => (p.id === pageId(n) ? { ...p, revision: p.revision + 1, ...change } : p))
}
export const deleteRemote = (world: World, n: number) => {
  const gone = new Set([pageId(n)])
  let grew = true
  while (grew) {
    grew = false
    for (const p of world.pages) {
      if (p.parentPageId && gone.has(p.parentPageId) && !gone.has(p.id)) { gone.add(p.id); grew = true }
    }
  }
  world.pages = world.pages.filter((p) => !gone.has(p.id))
}
export const entryOf = (world: World, n: number): SyncEntry => world.entries.find((e) => e.pageId === pageId(n))!
export const setEntry = (world: World, n: number, change: Partial<SyncEntry>) => {
  world.entries = world.entries.map((e) => (e.pageId === pageId(n) ? { ...e, ...change } : e))
}

// ── Reading a plan ──────────────────────────────────────────────────────────

export const types = (plan: ReconcilePlan): string[] => plan.actions.map((action) => action.type)
export const ofType = <T extends ReconcileAction['type']>(plan: ReconcilePlan, type: T) =>
  plan.actions.filter((action): action is Extract<ReconcileAction, { type: T }> => action.type === type)
/** Every reason the plan tells the person: rows, conflict copies and quarantines. */
export const reasons = (plan: ReconcilePlan): string[] => plan.actions.flatMap((action) => {
  if (action.type === 'recordConflict') return [action.conflict.reason]
  if (action.type === 'conflictCopy' || action.type === 'quarantine') return [action.reason]
  if (action.type === 'merge') return []
  return []
})
/** Action types that do I/O or write the server, without bookkeeping. */
export const effects = (plan: ReconcilePlan): string[] =>
  types(plan).filter((type) => !['recordConflict', 'setEntryState'].includes(type))
