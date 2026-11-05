import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isIgnoredName } from '../../../src/folder-sync/ignore.js'
import { nameKey } from '../../../src/folder-sync/path-mapping.js'
import { bypassHooks } from './fs-hooks.js'
import type { Prng } from './prng.js'

/**
 * The person at a computer: they create, edit, rename, move and delete files
 * and folders in the synced folder, sometimes while the engine is mid-pass.
 * Every byte they write is entered in the ledger; every byte they overwrite or
 * delete themselves is released from it — that, and only that, may be lost.
 */

export const hashOf = (bytes: Uint8Array | string): string =>
  `sha256:${createHash('sha256').update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).digest('hex')}`

/** What must still exist somewhere at the end: everything written, minus what the person destroyed. */
export class ContentLedger {
  private readonly written = new Map<string, string>()
  private readonly released = new Set<string>()

  write(hash: string, what: string): void {
    this.written.set(hash, what)
    this.released.delete(hash)
  }

  release(hash: string): void {
    this.released.add(hash)
  }

  required(): Array<[hash: string, what: string]> {
    return [...this.written].filter(([hash]) => !this.released.has(hash))
  }
}

export type TreeItem = { relPath: string; type: 'file' | 'directory'; absolute: string }

/** The synced items under the team folder (ignored names and what is below them left out). */
export const listTree = async (teamDir: string, includeIgnored = false): Promise<TreeItem[]> => {
  const items: TreeItem[] = []
  const walk = async (dirRel: string): Promise<void> => {
    const names = await readdir(dirRel === '' ? teamDir : join(teamDir, ...dirRel.split('/'))).catch(() => [] as string[])
    for (const name of names.sort()) {
      if (!includeIgnored && isIgnoredName(name)) continue
      const relPath = dirRel === '' ? name : `${dirRel}/${name}`
      const absolute = join(teamDir, ...relPath.split('/'))
      const found = await lstat(absolute).catch(() => null)
      if (!found) continue
      if (found.isDirectory()) {
        items.push({ relPath, type: 'directory', absolute })
        await walk(relPath)
      } else if (found.isFile()) {
        items.push({ relPath, type: 'file', absolute })
      }
    }
  }
  await walk('')
  return items
}

const FILE_STEMS = ['notes', 'Plan', 'plan', 'todo', 'Report', 'draft', 'Café', 'Café', 'a b', 'data']
const FILE_EXTENSIONS = ['.md', '.txt', '.bin']
const FOLDER_NAMES = ['Docs', 'docs', 'Archive', 'Work', 'Café', 'x']

/** Unique text: every write in a world holds a token no other write has, so its hash is its identity. */
export const freshLines = (token: () => string, count: number): string =>
  Array.from({ length: count }, () => `line ${token()}`).join('\n') + '\n'

/** Change one line (or add one): two such edits on different lines merge cleanly (R3). */
export const editedText = (rng: Prng, text: string, token: () => string): string => {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  if (lines.length === 0 || rng.chance(0.25)) lines.push(`line ${token()}`)
  else lines[rng.int(lines.length)] = `line ${token()}`
  return `${lines.join('\n')}\n`
}

const busy = (error: unknown): boolean =>
  ['EBUSY', 'EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')

export type PersonContext = {
  rng: Prng
  ledger: ContentLedger
  token: () => string
  log: (message: string) => void
}

const filesWithin = (items: readonly TreeItem[], relPath: string): TreeItem[] =>
  items.filter((item) => item.type === 'file' && (item.relPath === relPath || item.relPath.startsWith(`${relPath}/`)))

const releaseFiles = async (ledger: ContentLedger, files: readonly TreeItem[]): Promise<void> => {
  for (const file of files) {
    const bytes = await readFile(file.absolute).catch(() => null)
    if (bytes) ledger.release(hashOf(bytes))
  }
}

const taken = (items: readonly TreeItem[], dir: string, name: string): boolean =>
  items.some((item) => nameKey(item.relPath) === nameKey(dir === '' ? name : `${dir}/${name}`))

const parentOf = (relPath: string): string => (relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '')

/** Write a file the way an editor saves it; false when the save failed (the file was held, read-only, or gone). */
export const personWrite = async (
  person: PersonContext, teamDir: string, relPath: string, content: string, what: string,
): Promise<boolean> => bypassHooks(async () => {
  const absolute = join(teamDir, ...relPath.split('/'))
  const before = await readFile(absolute).catch(() => null)
  try {
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, content)
  } catch (error) {
    if (busy(error)) return false
    throw error
  }
  if (before) person.ledger.release(hashOf(before))
  person.ledger.write(hashOf(content), what)
  person.log(`${what} ${relPath}`)
  return true
})

/** One random thing the person does in the folder. */
export const personOperation = async (person: PersonContext, teamDir: string, label: string): Promise<void> => {
  const { rng } = person
  const items = await listTree(teamDir)
  const dirs = items.filter((item) => item.type === 'directory')
  const spaceDirs = dirs.filter((item) => !item.relPath.includes('/'))
  const inner = items.filter((item) => item.relPath.includes('/'))
  const files = items.filter((item) => item.type === 'file')
  if (spaceDirs.length === 0) return
  const op = rng.weighted<string>([
    [5, 'create'], [7, 'edit'], [2, 'rename'], [2, 'move'], [2, 'delete'], [1, 'mkdir'], [0.3, 'unlock'],
    [0.15, 'deleteSpace'],
  ])
  await bypassHooks(async () => {
    try {
      await runPersonOperation(person, teamDir, label, op, { items, dirs, spaceDirs, inner, files })
    } catch (error) {
      if (!busy(error)) throw error
      person.log(`${label}: ${op} failed (${(error as NodeJS.ErrnoException).code})`)
    }
  })
}

type Listing = {
  items: TreeItem[]; dirs: TreeItem[]; spaceDirs: TreeItem[]; inner: TreeItem[]; files: TreeItem[]
}

const runPersonOperation = async (
  person: PersonContext, teamDir: string, label: string, op: string, list: Listing,
): Promise<void> => {
  const { rng, ledger, token, log } = person
  const at = (relPath: string) => join(teamDir, ...relPath.split('/'))
  if (op === 'create' || ((op === 'edit' || op === 'unlock') && list.files.length === 0)) {
    const dir = rng.pick(list.dirs).relPath
    const name = `${rng.pick(FILE_STEMS)}${rng.pick(FILE_EXTENSIONS)}`
    if (taken(list.items, dir, name)) return
    await personWrite(person, teamDir, `${dir}/${name}`, freshLines(token, rng.between(2, 5)), `${label} creates`)
    return
  }
  if (op === 'edit' || op === 'unlock') {
    const file = rng.pick(list.files)
    const mode = (await stat(file.absolute)).mode
    if ((mode & 0o200) === 0) {
      if (op !== 'unlock') return
      await chmod(file.absolute, 0o644) // R1: the person clears the read-only attribute and edits anyway
    }
    const text = await readFile(file.absolute, 'utf8')
    await personWrite(person, teamDir, file.relPath, editedText(rng, text, token), `${label} edits`)
    return
  }
  if (op === 'rename' && list.inner.length > 0) {
    const item = rng.pick(list.inner)
    const dir = parentOf(item.relPath)
    const old = item.relPath.slice(dir.length + 1)
    const caseOnly = rng.chance(0.2) && old !== old.toUpperCase()
    const name = caseOnly ? old.toUpperCase()
      : item.type === 'file' ? `${rng.pick(FILE_STEMS)}${old.slice(old.lastIndexOf('.'))}` : rng.pick(FOLDER_NAMES)
    if (!caseOnly && taken(list.items, dir, name)) return
    await rename(item.absolute, at(`${dir}/${name}`))
    log(`${label} renames ${item.relPath} -> ${dir}/${name}`)
    return
  }
  if (op === 'move' && list.inner.length > 0) {
    const item = rng.pick(list.inner)
    const name = item.relPath.slice(item.relPath.lastIndexOf('/') + 1)
    const targets = list.dirs.filter((dir) => dir.relPath !== parentOf(item.relPath)
      && dir.relPath !== item.relPath && !dir.relPath.startsWith(`${item.relPath}/`))
    if (targets.length === 0) return
    const target = rng.pick(targets).relPath
    if (taken(list.items, target, name)) return
    await rename(item.absolute, at(`${target}/${name}`))
    log(`${label} moves ${item.relPath} -> ${target}/${name}`)
    return
  }
  if ((op === 'delete' && list.inner.length > 0) || (op === 'deleteSpace' && list.spaceDirs.length > 0)) {
    const item = op === 'delete' ? rng.pick(list.inner) : rng.pick(list.spaceDirs)
    // Everything the person deletes goes, kept edits beside read-only files included.
    await releaseFiles(ledger, filesWithin(await listTree(teamDir, true), item.relPath))
    await rm(item.absolute, { recursive: true, force: true, maxRetries: 2 })
    log(`${label} deletes ${item.relPath}`)
    return
  }
  if (op === 'mkdir') {
    const dir = rng.pick(list.dirs).relPath
    const name = rng.pick(FOLDER_NAMES)
    if (taken(list.items, dir, name)) return
    await mkdir(at(`${dir}/${name}`))
    log(`${label} makes folder ${dir}/${name}`)
  }
}
