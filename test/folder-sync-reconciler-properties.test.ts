import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ConflictReportSchema, FolderSyncRelPathSchema, type SyncPage } from '@nessie/executor-protocol'

import type { ReconcileAction } from '../src/folder-sync/types.js'
import {
  NOW, deleteLocal, deleteRemote, editLocal, editRemote, hash, moveLocalItem, pageId, run, setEntry,
  syncedWorld, updateRemote, type PageSpec, type World,
} from './folder-sync-fixtures.js'

/**
 * Property checks over every combination of local change × remote change ×
 * page kind × open conflict × held merge base: whatever the reconciler plans,
 * no action may destroy bytes that exist nowhere else (the "zero data loss"
 * oracle), every name must be valid, and no write may bypass R1, A3 or a
 * closed conflict. A failing case prints its coordinates for replay.
 */

const KINDS: Record<string, PageSpec> = {
  document: { n: 1, title: 'Doc', content: 'base\n' },
  lossy: { n: 1, title: 'Doc', content: 'base\n', readOnlyReason: 'document_formatting' },
  text: { n: 1, title: 'notes.txt', kind: 'file', extension: 'txt', content: 'base\n' },
  binary: { n: 1, title: 'photo.png', kind: 'file', extension: 'png', mime: 'image/png', content: 'base' },
  spreadsheet: { n: 1, title: 'Budget', kind: 'spreadsheet', content: 'base' },
  published: { n: 1, title: 'Doc', content: 'base\n', readOnlyReason: 'published' },
}
const LOCAL = ['same', 'modified', 'deleted', 'renamed', 'renamed_modified', 'unstable', 'unhashed'] as const
const REMOTE = [
  'same', 'modified', 'deleted', 'renamed', 'renamed_modified', 'access_lost', 'readonly_now',
] as const
const LOCAL_TEXT = 'only on this disk'

type Case = {
  kind: string
  local: (typeof LOCAL)[number]
  remote: (typeof REMOTE)[number]
  open: boolean
  base: boolean
}

const build = (c: Case): { world: World; path: string } => {
  const copy: PageSpec = { n: 2, title: 'copy', content: 'copy bytes' }
  const world = syncedWorld([KINDS[c.kind]!, copy, { n: 3, title: 'Sibling', content: 'sibling' }])
  const path = world.entries.find((entry) => entry.pageId === pageId(1))!.relPath
  if (c.open) {
    setEntry(world, 1, {
      state: 'conflict',
      openConflict: { clientConflictId: 'c', copyPageId: pageId(2), copyRelPath: 'Space/copy.md', copyHash: hash('copy bytes') },
    })
  }
  const renamed = path.replace('/', '/Renamed ')
  switch (c.local) {
    case 'same': break
    case 'modified': editLocal(world, path, LOCAL_TEXT); break
    case 'deleted': deleteLocal(world, path); break
    case 'renamed': moveLocalItem(world, path, renamed); break
    case 'renamed_modified':
      moveLocalItem(world, path, renamed)
      editLocal(world, renamed, LOCAL_TEXT)
      break
    case 'unstable': editLocal(world, path, LOCAL_TEXT, { stableSinceMs: NOW - 100 }); break
    case 'unhashed': editLocal(world, path, LOCAL_TEXT, { contentHash: null }); break
  }
  switch (c.remote) {
    case 'same': break
    case 'modified': editRemote(world, 1, 'remote edit', 11); break
    case 'deleted': deleteRemote(world, 1); break
    case 'renamed': updateRemote(world, 1, { title: 'Theirs' }); break
    case 'renamed_modified':
      updateRemote(world, 1, { title: 'Theirs' })
      editRemote(world, 1, 'remote edit', 11)
      break
    case 'access_lost': world.spaces = []; world.pages = []; break
    case 'readonly_now':
      if (KINDS[c.kind]!.readOnlyReason || c.kind === 'spreadsheet') break
      world.pages = world.pages.map((p): SyncPage => (p.id === pageId(1)
        ? { ...p, readOnly: true, readOnlyReason: 'no_write_access' } : p))
      break
  }
  return { world, path }
}

const pathsOf = (action: ReconcileAction): string[] => {
  switch (action.type) {
    case 'moveLocal': case 'moveRemote': return [action.fromRelPath, action.toRelPath]
    case 'quarantine': case 'conflictCopy': return [action.relPath, action.copyRelPath]
    case 'recordConflict': return [action.conflict.relPath]
    case 'setEntryState': return []
    default: return [action.relPath]
  }
}

const cases: Case[] = []
for (const kind of Object.keys(KINDS)) {
  for (const local of LOCAL) {
    for (const remote of REMOTE) {
      for (const open of [false, true]) {
        for (const base of [false, true]) cases.push({ kind, local, remote, open, base })
      }
    }
  }
}

test(`no data loss, valid names, no bypassed guard — ${cases.length} combinations`, () => {
  for (const c of cases) {
    const where = JSON.stringify(c)
    const { world } = build(c)
    const plan = run(world, { mergeBases: c.base ? new Set([pageId(1)]) : new Set() })
    const actions = plan.actions
    const localChanged = ['modified', 'renamed_modified', 'unstable', 'unhashed'].includes(c.local)
    const unique = localChanged ? hash(LOCAL_TEXT) : null
    const readOnly = Boolean(KINDS[c.kind]!.readOnlyReason) || c.kind === 'spreadsheet' || c.remote === 'readonly_now'

    for (const action of actions) {
      for (const path of pathsOf(action)) assert.ok(FolderSyncRelPathSchema.safeParse(path).success, `${where}: bad path ${path}`)
      if (action.type === 'recordConflict') ConflictReportSchema.parse(action.conflict)
      // Overwriting the only copy of local bytes.
      if (action.type === 'download' && unique !== null) {
        assert.notEqual(action.expect.local?.contentHash, unique, `${where}: download overwrites unsent bytes`)
      }
      if (action.type === 'download' && c.local === 'unhashed') {
        assert.fail(`${where}: download over a file nobody hashed`)
      }
      // Writes only to the entry's page or its open conflict's copy (never a closed one).
      if (action.type === 'upload') {
        const allowed = c.open ? [pageId(1), pageId(2)] : [pageId(1)]
        assert.ok(allowed.includes(action.pageId), `${where}: upload to ${action.pageId}`)
        assert.ok(localChanged, `${where}: upload with L == B (A3)`)
      }
      if (readOnly && ['upload', 'moveRemote', 'archiveRemote', 'merge'].includes(action.type)
        && 'pageId' in action && action.pageId === pageId(1)) {
        assert.fail(`${where}: ${action.type} to a read-only page (R1)`)
      }
      if (action.type === 'archiveRemote' && action.pageId === pageId(1)) {
        // Rename detection is file id *and* hash: a rename with new bytes is a delete plus a create.
        assert.ok(c.local === 'deleted' || c.local === 'renamed_modified', `${where}: archive without a local delete`)
        if (c.local === 'renamed_modified') {
          assert.ok(actions.some((a) => a.type === 'createRemote' && a.expect.local?.contentHash === unique), `${where}`)
        }
        assert.ok(!['modified', 'renamed_modified'].includes(c.remote), `${where}: delete beat an edit (R4)`)
      }
    }
    // Forgetting an entry with unsent bytes must come with a new page for them or a trash copy.
    if (unique !== null && c.local !== 'unstable' && c.local !== 'unhashed') {
      const forgot = actions.some((a) => a.type === 'forgetEntry' && a.pageId === pageId(1))
      const kept = actions.some((a) => (
        (a.type === 'createRemote' || a.type === 'upload' || a.type === 'conflictCopy' || a.type === 'quarantine'
          || a.type === 'merge') && a.expect.local?.contentHash === unique
      ) || a.type === 'trashLocal')
      if (forgot) assert.ok(kept, `${where}: forgot an entry holding unsent bytes`)
    }
    // An unsettled file is never acted on.
    if (c.local === 'unstable' || c.local === 'unhashed') {
      const touched = actions.filter((a) => !['recordConflict', 'setEntryState'].includes(a.type)
        && 'pageId' in a && a.pageId === pageId(1) && a.type !== 'trashLocal')
      assert.deepEqual(touched, [], `${where}: acted on an unsettled file`)
    }
  }
})

test('the pure engine modules import no file system, process or network module', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'folder-sync')
  const io = '(?:node:)?(?:fs|fs/promises|child_process|net|http|https|http2|dgram|tls|dns|worker_threads)'
  const banned = new RegExp(String.raw`(?:from\s+|import\(\s*)['"]${io}['"]`, 'u')
  const modules = readdirSync(dir).filter((name) => name.endsWith('.ts'))
  for (const name of [
    'reconciler.ts', 'path-mapping.ts', 'merge.ts', 'plan-brake.ts', 'index-store.ts', 'ignore.ts', 'line-diff.ts',
    'reconcile-classify.ts', 'reconcile-conflicts.ts', 'reconcile-context.ts', 'reconcile-entries.ts',
    'reconcile-manifest.ts', 'reconcile-model.ts', 'reconcile-untracked.ts',
  ]) {
    assert.ok(modules.includes(name), `${name} exists`)
    const source = readFileSync(join(dir, name), 'utf8')
    assert.doesNotMatch(source, banned, `${name} imports I/O`)
    assert.doesNotMatch(source, /\bfetch\s*\(|\bprocess\.|\bsetTimeout\s*\(|\bDate\.now\s*\(/u, `${name} reads the world`)
  }
})
