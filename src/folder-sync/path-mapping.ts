import { FOLDER_SYNC_PATH_LIMITS } from '@nessie/executor-protocol'

import { isIgnoredName } from './ignore.js'
import type { FolderSyncPageKind } from './types.js'

/**
 * Where every page lives on disk, as a pure function of the manifest
 * (`docs/plans/2026-11-03-nessie-folder-sync.md` §2.3). Every computer and
 * every pass computes the same tree from the same pages, so the mapping is the
 * single answer to "which file is this page".
 *
 * Paths are relative to the team folder: `<Space dir>/<page tree…>`, forward
 * slashes. Names are compared case-insensitively after NFC, on every platform,
 * because macOS and Windows file systems are case-insensitive and one rule
 * everywhere keeps the mapping portable.
 */

/** What the mapping reads of a page. `SyncPage` satisfies it. */
export type MappingPage = {
  id: string
  spaceId: string
  parentPageId: string | null
  kind: FolderSyncPageKind
  title: string
  createdAt: string
  head: { extension: string | null } | null
}

/** What the mapping reads of a space. `SyncSpace` satisfies it. */
export type MappingSpace = {
  id: string
  name: string
  personal: boolean
}

export type UnmappableReason = 'orphan' | 'path_too_long'

export type TreeMapping = {
  /** Space id → its directory, one segment under the team folder. */
  spaceDirs: ReadonlyMap<string, string>
  /** Page id → its path relative to the team folder. */
  paths: ReadonlyMap<string, string>
  /** Pages with no path, and why; they never block the rest (C20). */
  unmappable: ReadonlyMap<string, UnmappableReason>
}

/** The personal space's directory name (plan §2.2). */
export const PERSONAL_SPACE_DIR_NAME = 'My Documents'

const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*]/gu
const TRAILING_DOTS_AND_SPACES = /[. ]+$/u
const ID_TAG_LENGTH = 6

const encoder = new TextEncoder()
export const utf8Bytes = (value: string): number => encoder.encode(value).length

/**
 * The key two sibling names collide on: NFC, then case-folded through upper
 * case, as NTFS and APFS compare — `ς`/`σ`, `ſ`/`s`, `ı`/`i` and `µ`/`μ` name
 * one file there although their plain lower cases differ.
 */
export const nameKey = (name: string): string => name.normalize('NFC').toUpperCase().toLowerCase()

/** The `~<6 hex>` tag a truncated name carries: the page id's first hex digits. */
export const idTag = (id: string): string => id.replace(/[^0-9a-f]/giu, '').slice(0, ID_TAG_LENGTH).toLowerCase()

/** The parts of one name before it is rendered within a byte budget. */
export type NameParts = {
  base: string
  /** Including the dot; empty for none. */
  ext: string
  /** The id the `~` tag comes from when the base must be truncated. */
  id: string
  /** The sibling disambiguation number, ` (2)` and up; null for the plain name. */
  dup: number | null
}

/**
 * NFC, strip control characters, replace characters Windows refuses, and turn
 * a leading dot into `_.` so the file is not hidden (hidden names are ignored).
 */
const cleanTitle = (title: string): string => {
  const cleaned = title.normalize('NFC').replace(CONTROL_CHARACTERS, '').replace(ILLEGAL_CHARACTERS, '_')
  return cleaned.startsWith('.') ? `_${cleaned}` : cleaned
}

/** Trim trailing dots and spaces, guard reserved device names, never empty. */
const cleanBase = (base: string): string => {
  const trimmed = base.replace(TRAILING_DOTS_AND_SPACES, '')
  if (trimmed === '') return '_'
  const device = trimmed.split('.')[0]!.replace(/ +$/u, '').toUpperCase()
  return RESERVED_DEVICE_NAMES.has(device) ? `_${trimmed}` : trimmed
}

/** Free text made safe as one path segment, without an extension. */
export const cleanSegment = (text: string): string => cleanBase(cleanTitle(text))

/**
 * A mapped name is never one the scanner skips (`ignore.ts`): a file there
 * would be written but its edits never read, and its page would wait forever.
 * `~$x`, `#x#` and `Thumbs.db` take a leading `_`; a temporary extension
 * (`.tmp`, `.part`, …) takes a trailing one.
 */
const unignored = (parts: NameParts): NameParts => {
  if (!isIgnoredName(`${parts.base}${parts.ext}`)) return parts
  if (!isIgnoredName(`_${parts.base}${parts.ext}`)) return { ...parts, base: `_${parts.base}` }
  return parts.ext === '' ? { ...parts, base: `${parts.base}_` } : { ...parts, ext: `${parts.ext}_` }
}

const rawNameParts = (
  page: Pick<MappingPage, 'id' | 'kind' | 'title' | 'head'>,
): NameParts => {
  const title = cleanTitle(page.title)
  if (page.kind === 'folder') return { base: cleanBase(title), ext: '', id: page.id, dup: null }
  if (page.kind === 'document') return { base: cleanBase(title), ext: '.md', id: page.id, dup: null }
  if (page.kind === 'spreadsheet') return { base: cleanBase(title), ext: '.xlsx', id: page.id, dup: null }
  const extension = page.head?.extension ?? null
  if (extension === null) return { base: cleanBase(title), ext: '', id: page.id, dup: null }
  const suffix = `.${extension}`
  if (title.length > suffix.length && title.toLowerCase().endsWith(suffix)) {
    return { base: cleanBase(title.slice(0, -suffix.length)), ext: title.slice(-suffix.length), id: page.id, dup: null }
  }
  return { base: cleanBase(title), ext: suffix, id: page.id, dup: null }
}

/** Split a title into base and extension by the page's kind (plan §2.2). */
export const nameParts = (
  page: Pick<MappingPage, 'id' | 'kind' | 'title' | 'head'>,
): NameParts => unignored(rawNameParts(page))

const truncateToBytes = (value: string, maxBytes: number): string => {
  let result = ''
  let bytes = 0
  for (const codePoint of value) {
    const size = utf8Bytes(codePoint)
    if (bytes + size > maxBytes) break
    result += codePoint
    bytes += size
  }
  return result
}

/**
 * Render a name within `maxBytes`. A name that does not fit keeps as much of
 * its base as fits, then `~<6 hex of the id>`, the sibling suffix and the
 * extension. Null when even an empty base does not fit.
 */
export const renderName = (parts: NameParts, maxBytes: number): string | null => {
  const dup = parts.dup === null ? '' : ` (${parts.dup})`
  const plain = `${parts.base}${dup}${parts.ext}`
  if (utf8Bytes(plain) <= maxBytes) return plain
  const tail = `~${idTag(parts.id)}${dup}${parts.ext}`
  const budget = maxBytes - utf8Bytes(tail)
  if (budget < 1) return null
  const base = truncateToBytes(parts.base, budget)
  return base === '' ? null : `${base}${tail}`
}

type Sibling = { parts: NameParts; createdAt: string; id: string }

/**
 * Give each sibling a distinct name: in `(createdAt, id)` order, the oldest
 * keeps the plain name and later ones take ` (2)`, ` (3)`, … — the first
 * number whose rendering no earlier sibling holds.
 */
export const allocateSiblingNames = (
  siblings: readonly Sibling[],
  maxBytes: number,
): Map<string, string | null> => {
  const ordered = [...siblings].sort((a, b) => (
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  ))
  const taken = new Set<string>()
  const names = new Map<string, string | null>()
  for (const sibling of ordered) {
    let name: string | null = null
    for (let dup: number | null = null; ; dup = dup === null ? 2 : dup + 1) {
      const candidate = renderName({ ...sibling.parts, dup }, maxBytes)
      if (candidate === null) break
      if (!taken.has(nameKey(candidate))) {
        name = candidate
        break
      }
    }
    if (name !== null) taken.add(nameKey(name))
    names.set(sibling.id, name)
  }
  return names
}

/** A space's directory name before sibling disambiguation. */
const spaceParts = (space: MappingSpace): NameParts => unignored({
  base: cleanBase(cleanTitle(space.personal ? PERSONAL_SPACE_DIR_NAME : space.name)),
  ext: '',
  id: space.id,
  dup: null,
})

/**
 * The whole tree. Space directories are siblings under the team folder; the
 * personal space sorts first, then by id (spaces carry no creation time).
 * Each segment is capped at 200 bytes and at what is left of the 900-byte path
 * budget, so the deepest segment absorbs a long path first; a page that cannot
 * fit even a tagged stub, or whose parent is not a mapped folder, is
 * unmappable — it and its subtree are listed, never block the rest.
 */
export const mapTree = (spaces: readonly MappingSpace[], pages: readonly MappingPage[]): TreeMapping => {
  const { segmentBytes, relativePathBytes } = FOLDER_SYNC_PATH_LIMITS
  const spaceDirs = new Map<string, string>()
  const spaceOrder = [...spaces].sort((a, b) => (
    a.personal !== b.personal ? (a.personal ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  ))
  const spaceNames = allocateSiblingNames(
    spaceOrder.map((space, index) => ({ parts: spaceParts(space), createdAt: String(index).padStart(8, '0'), id: space.id })),
    segmentBytes,
  )
  for (const space of spaceOrder) {
    const name = spaceNames.get(space.id)
    if (name) spaceDirs.set(space.id, name)
  }

  const children = new Map<string, MappingPage[]>()
  const groupKey = (spaceId: string, parentPageId: string | null) => `${spaceId}/${parentPageId ?? ''}`
  for (const page of pages) {
    const key = groupKey(page.spaceId, page.parentPageId)
    const group = children.get(key)
    if (group) group.push(page)
    else children.set(key, [page])
  }

  const paths = new Map<string, string>()
  const unmappable = new Map<string, UnmappableReason>()
  const placeGroup = (spaceId: string, parentPageId: string | null, parentPath: string) => {
    const group = children.get(groupKey(spaceId, parentPageId))
    if (!group) return
    const budget = Math.min(segmentBytes, relativePathBytes - utf8Bytes(parentPath) - 1)
    const names = allocateSiblingNames(
      group.map((page) => ({ parts: nameParts(page), createdAt: page.createdAt, id: page.id })),
      budget,
    )
    for (const page of group) {
      const name = names.get(page.id)
      if (!name) {
        markSubtree(page, 'path_too_long')
        continue
      }
      const path = `${parentPath}/${name}`
      paths.set(page.id, path)
      if (page.kind === 'folder') placeGroup(spaceId, page.id, path)
      else markChildren(page, 'orphan')
    }
  }
  const markChildren = (page: MappingPage, reason: UnmappableReason) => {
    for (const child of children.get(groupKey(page.spaceId, page.id)) ?? []) markSubtree(child, reason)
  }
  const markSubtree = (page: MappingPage, reason: UnmappableReason) => {
    if (unmappable.has(page.id)) return
    unmappable.set(page.id, reason)
    markChildren(page, reason)
  }

  for (const [spaceId, dir] of spaceDirs) placeGroup(spaceId, null, dir)
  for (const page of pages) {
    if (!paths.has(page.id) && !unmappable.has(page.id)) unmappable.set(page.id, 'orphan')
  }
  return { spaceDirs, paths, unmappable }
}

/**
 * The title a local name asks for (plan §2.3 rule 4): NFC, without the kind's
 * extension. A document drops `.md`; a file's title is its whole name; a
 * ` (N)` suffix, a `~` tag or a `_.` prefix is kept literally — we never guess
 * whether a person typed it. Null when nothing is left to be a title.
 */
export const titleForLocalName = (name: string, kind: FolderSyncPageKind): string | null => {
  const normalized = name.normalize('NFC')
  let title = normalized
  if (kind === 'document' && normalized.toLowerCase().endsWith('.md')) title = normalized.slice(0, -3)
  if (kind === 'spreadsheet' && normalized.toLowerCase().endsWith('.xlsx')) title = normalized.slice(0, -5)
  return title.trim() === '' ? null : title
}

/**
 * The team's folder under the root: its display name, cleaned like any
 * folder, with the short team id appended when another team already holds the
 * name (plan §2.2).
 */
export const teamFolderName = (teamLabel: string, teamId: string, takenNames: readonly string[]): string => {
  const parts = unignored({ base: cleanBase(cleanTitle(teamLabel)), ext: '', id: teamId, dup: null })
  const plain = renderName(parts, FOLDER_SYNC_PATH_LIMITS.segmentBytes) ?? `_~${idTag(teamId)}`
  const taken = new Set(takenNames.map(nameKey))
  if (!taken.has(nameKey(plain))) return plain
  return renderName({ ...parts, base: `${parts.base} ${idTag(teamId)}` }, FOLDER_SYNC_PATH_LIMITS.segmentBytes)
    ?? `_~${idTag(teamId)}`
}

/** `a/b/c.md` → `a/b`; a top-level segment's parent is the empty string. */
export const parentPath = (relPath: string): string => {
  const index = relPath.lastIndexOf('/')
  return index < 0 ? '' : relPath.slice(0, index)
}

/** `a/b/c.md` → `c.md`. */
export const baseName = (relPath: string): string => relPath.slice(relPath.lastIndexOf('/') + 1)

/** `a/b/c.md` → `a`. */
export const firstSegment = (relPath: string): string => relPath.split('/')[0]!

/** True when `relPath` is `ancestor` or below it. */
export const isWithin = (relPath: string, ancestor: string): boolean =>
  relPath === ancestor || relPath.startsWith(`${ancestor}/`)

/** Split `name` into the part before its last dot and the extension with the dot. */
export const splitExtension = (name: string): { stem: string; ext: string } => {
  const index = name.lastIndexOf('.')
  return index <= 0 ? { stem: name, ext: '' } : { stem: name.slice(0, index), ext: name.slice(index) }
}
