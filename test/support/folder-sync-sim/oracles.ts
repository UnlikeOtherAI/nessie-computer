import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { folderSyncCountsAreSettled } from '@nessie/executor-protocol'

import { applyRecord, parseIndex, parseJournal, type IndexFile } from '../../../src/folder-sync/index-store.js'
import { isIgnoredPath } from '../../../src/folder-sync/ignore.js'
import { mapTree, nameKey } from '../../../src/folder-sync/path-mapping.js'
import { ConflictBook } from '../../../src/folder-sync/report.js'
import { folderSyncPaths } from '../../../src/folder-sync/state-files.js'
import { hashOf, listTree } from './local-ops.js'
import type { SimReplica } from './replica.js'
import type { SimWorld } from './world.js'

/**
 * The simulator's oracles (amendment A12.11, conflict-research addendum #16),
 * judged once the world is quiet. Each returns the violations it found, each
 * a sentence naming the computer and the path.
 */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/u

/** A name every supported file system accepts and the mapping could have produced. */
export const validName = (name: string): boolean =>
  name !== '' && !ILLEGAL.test(name) && !/[. ]$/u.test(name) && !RESERVED.test(name.split('.')[0]!.trimEnd())
  && new TextEncoder().encode(name).length <= 200

const walkFiles = async (dir: string, found: string[] = []): Promise<string[]> => {
  const names = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of names) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(path, found)
    else if (entry.isFile()) found.push(path)
  }
  return found
}

/** Zero data loss: every byte anyone wrote and nobody deliberately destroyed is somewhere a person can get it back. */
export const zeroDataLoss = async (world: SimWorld): Promise<string[]> => {
  const held = world.server.heldHashes()
  for (const replica of world.replicas) {
    for (const file of await walkFiles(replica.tmp)) {
      const bytes = await readFile(file).catch(() => null)
      if (bytes) held.add(hashOf(bytes))
    }
  }
  return world.ledger.required()
    .filter(([hash]) => !held.has(hash))
    .map(([hash, what]) => `bytes lost: "${what}" (${hash.slice(7, 19)}) are nowhere — not in Nessie, a folder, a copy or the trash`)
}

/** What every computer's folder must hold: the server's live tree, mapped. */
const expectedTree = (world: SimWorld) => {
  const { server } = world
  const pages = server.livePages().map((page) => server.project(page))
  const mapping = mapTree(server.spaces, pages)
  const expected = new Map<string, { type: 'file' | 'directory'; hash: string | null }>()
  for (const page of pages) {
    const path = mapping.paths.get(page.id)
    if (!path) continue
    expected.set(path, page.kind === 'folder'
      ? { type: 'directory', hash: null }
      : { type: 'file', hash: page.head?.contentHash ?? null })
  }
  return { expected, spaceDirs: new Set(mapping.spaceDirs.values()) }
}

/** Every computer's tree equals Nessie's, byte for byte; names valid; no leftovers of our own. */
export const convergence = async (world: SimWorld): Promise<string[]> => {
  const problems: string[] = []
  const { expected, spaceDirs } = expectedTree(world)
  for (const replica of world.replicas) {
    const teamDir = replica.teamDir()
    const all = await listTree(teamDir, true)
    for (const item of all) {
      const name = item.relPath.slice(item.relPath.lastIndexOf('/') + 1)
      if (name.startsWith('.nessie-sync-')) problems.push(`${replica.label}: leftover ${item.relPath}`)
    }
    const present = all.filter((item) => !isIgnoredPath(item.relPath))
    // A4: while a conflict is open, the canonical file may hold edits its copy page keeps.
    const preserved = new Map((await readIndex(replica)).entries
      .filter((entry) => entry.state === 'preserved' && entry.openConflict?.copyHash)
      .map((entry) => [entry.relPath, entry.openConflict!.copyHash!]))
    const seen = new Set<string>()
    for (const item of present) {
      seen.add(item.relPath)
      const name = item.relPath.slice(item.relPath.lastIndexOf('/') + 1)
      if (!validName(name)) problems.push(`${replica.label}: invalid name on disk ${JSON.stringify(item.relPath)}`)
      const want = expected.get(item.relPath)
      if (!want) {
        if (item.type === 'directory' && spaceDirs.has(item.relPath)) continue
        problems.push(`${replica.label}: ${item.relPath} is on disk but not in Nessie`)
        continue
      }
      if (want.type !== item.type) {
        problems.push(`${replica.label}: ${item.relPath} is a ${item.type} here, a ${want.type} in Nessie`)
      } else if (item.type === 'file') {
        const hash = hashOf(await readFile(item.absolute))
        if (hash !== want.hash && preserved.get(item.relPath) !== hash) {
          problems.push(`${replica.label}: ${item.relPath} differs from Nessie's head`)
        }
      }
    }
    for (const path of expected.keys()) {
      if (!seen.has(path)) problems.push(`${replica.label}: ${path} is in Nessie but not on disk`)
    }
  }
  return problems
}

/** Nessie's own invariants: guarded writes, immutable versions, a tree, one effect per operation. */
export const serverInvariants = (world: SimWorld): string[] => {
  const { server } = world
  const problems = [...server.audit.violations]
  for (const version of server.mutatedVersions()) problems.push(`version bytes changed: ${version}`)
  const live = server.livePages()
  for (const page of live) {
    const seen = new Set<string>()
    for (let current = page; current.parentPageId !== null;) {
      if (seen.has(current.id)) {
        problems.push(`the parent graph has a cycle through "${page.title}"`)
        break
      }
      seen.add(current.id)
      const parent = server.pages.get(current.parentPageId)
      if (!parent || parent.status !== 'live' || parent.kind !== 'folder' || parent.spaceId !== current.spaceId) {
        problems.push(`"${current.title}" hangs under a parent that is not a live folder of its space`)
        break
      }
      current = parent
    }
  }
  const liveIds = new Set(live.map((page) => page.id))
  const counts = new Map<string, number>()
  for (const effect of server.audit.effects) {
    let key: string | null = null
    if (effect.kind === 'version') key = `version|${effect.executorId}|${effect.pageId}|${effect.contentHash}`
    else if (effect.kind === 'create' && liveIds.has(effect.pageId)) {
      key = effect.pageKind === 'folder'
        ? `folder|${effect.executorId}|${effect.spaceId}/${effect.parentPageId}|${nameKey(effect.title)}`
        : `create|${effect.executorId}|${effect.contentHash}`
    }
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const [key, count] of counts) {
    if (count > 1) problems.push(`one operation took effect ${count} times: ${key.split('|')[0]} by ${server.labels.get(key.split('|')[1]!)}`)
  }
  return problems
}

const readIndex = async (replica: SimReplica): Promise<IndexFile> => {
  const paths = folderSyncPaths(replica.stateDir)
  let index = parseIndex(await readFile(join(paths.dir, 'index.json'), 'utf8').catch(() => null))
  const journal = await readFile(join(paths.dir, 'journal.ndjson'), 'utf8').catch(() => '')
  for (const record of parseJournal(journal)) index = applyRecord(index, record)
  return index
}

/**
 * Each computer's own state is honest: nothing left half-done, no entry
 * stuck without a row saying why, its open rows the ones Nessie holds, and
 * `up_to_date` exactly when it is.
 */
export const replicaHonesty = async (world: SimWorld, diverged: ReadonlySet<string>): Promise<string[]> => {
  const problems: string[] = []
  for (const replica of world.replicas) {
    const index = await readIndex(replica)
    const book = await ConflictBook.open(folderSyncPaths(replica.stateDir).conflicts)
    const open = book.open()
    const openIds = new Set(open.map((row) => row.report.clientConflictId))
    const state = await replica.state()
    if (index.pending.length > 0) {
      problems.push(`${replica.label}: ${index.pending.length} journaled actions never finished (${index.pending.map((p) => p.action.type).join(', ')})`)
    }
    if (index.installs.length > 0) problems.push(`${replica.label}: an install was never settled`)
    for (const entry of index.entries) {
      if (entry.state === 'synced') continue
      const rowed = (entry.openConflict && openIds.has(entry.openConflict.clientConflictId))
        || open.some((row) => row.report.pageId === entry.pageId)
      const fine = entry.state === 'held_delete' ? state.heldDeletes !== null
        : entry.state === 'error' ? entry.detail !== undefined && rowed
          : (entry.state === 'conflict' || entry.state === 'preserved') ? rowed : false
      if (!fine) problems.push(`${replica.label}: ${entry.relPath} is stuck ${entry.state} (${entry.detail?.code ?? 'no detail'}) with no row saying why`)
    }
    const rows = [...replica.view.conflicts.values()]
    for (const row of rows.filter((candidate) => candidate.state === 'resolving')) {
      problems.push(`${replica.label}: ${row.resolution} picked in Nessie for ${row.relPath} was never applied`)
    }
    const serverOpen = new Set(rows.filter((row) => row.state !== 'resolved').map((row) => row.clientConflictId))
    for (const id of openIds) if (!serverOpen.has(id)) problems.push(`${replica.label}: a row open here is not open in Nessie`)
    for (const id of serverOpen) if (!openIds.has(id)) problems.push(`${replica.label}: a row open in Nessie is not open here`)
    const settled = folderSyncCountsAreSettled(state.counts)
    if ((state.state === 'up_to_date') !== settled) {
      problems.push(`${replica.label}: state ${state.state} but the counts are ${settled ? '' : 'not '}settled`)
    }
    const converged = !diverged.has(replica.label)
    const attention = open.some((row) => row.report.kind !== 'info')
    if (converged && !attention && state.heldDeletes === null && state.state !== 'up_to_date') {
      problems.push(`${replica.label}: everything is in sync but the state says ${state.state}`)
    }
    if (state.state === 'up_to_date' && !converged) problems.push(`${replica.label}: says up_to_date while its folder differs from Nessie`)
  }
  return problems
}

