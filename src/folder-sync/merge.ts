import { FOLDER_SYNC_MERGE_MAX_BYTES } from '@nessie/executor-protocol'

import { diffLines, type LineChange } from './line-diff.js'

/**
 * R3: a line-based three-way merge (diff3) of text over (base, local,
 * remote). It merges only when no change on one side overlaps a change on the
 * other; everything else is a conflict and the caller keeps both versions
 * (R2). It refuses — never guesses — on bytes it cannot treat as text: over
 * 5 MiB, a NUL byte, invalid UTF-8, or mixed line endings within one input.
 *
 * Line endings, the byte-order mark and the final newline are properties of
 * the whole file, merged three-way like a line: a side that changed one wins
 * it; otherwise the other side's (equal to the base's when neither changed)
 * stands. Lines compare as exact strings, so Unicode is compared as its bytes.
 *
 * The base text comes from the local base store (A7), never a download.
 */

export type MergeRefusal =
  | 'too_large'
  | 'binary'
  | 'invalid_utf8'
  | 'mixed_line_endings'
  | 'too_complex'

export type MergeResult =
  | { type: 'merged'; text: string; bytes: Uint8Array }
  | { type: 'conflict' }
  | { type: 'refused'; reason: MergeRefusal }

/** Past this many line edits on one side the merge gives up (R2 is always safe). */
const MAX_EDITS = 4_000
const BOM = '﻿'

type Eol = '\n' | '\r\n'
type ParsedText = { lines: string[]; eol: Eol | null; bom: boolean; finalNewline: boolean }

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

const parse = (bytes: Uint8Array): ParsedText | MergeRefusal => {
  if (bytes.length > FOLDER_SYNC_MERGE_MAX_BYTES) return 'too_large'
  if (bytes.includes(0)) return 'binary'
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    return 'invalid_utf8'
  }
  const bom = text.startsWith(BOM)
  if (bom) text = text.slice(1)
  const crlf = (text.match(/\r\n/gu) ?? []).length
  const lf = (text.match(/\n/gu) ?? []).length - crlf
  if (crlf > 0 && lf > 0) return 'mixed_line_endings'
  const eol: Eol | null = crlf > 0 ? '\r\n' : lf > 0 ? '\n' : null
  if (text === '') return { lines: [], eol, bom, finalNewline: false }
  const lines = eol === null ? [text] : text.split(eol)
  const finalNewline = eol !== null && lines[lines.length - 1] === ''
  if (finalNewline) lines.pop()
  return { lines, eol, bom, finalNewline }
}

/** A whole-file property, merged three-way. */
const pick = <T>(base: T, local: T, remote: T): T => (local !== base ? local : remote)

/** Changes from either side that overlap, gathered into one region of the base. */
type Region = { start: number; end: number; local: LineChange[]; remote: LineChange[] }

/**
 * Two changes collide when their base ranges intersect. An insertion (an
 * empty range) collides with any change that touches its anchor, including
 * the other side's insertion at the same place — their order is a guess.
 */
const collide = (region: { start: number; end: number }, change: LineChange): boolean => {
  if (region.start === region.end || change.start === change.end) {
    return change.start <= region.end && region.start <= change.end
  }
  return change.start < region.end && region.start < change.end
}

const regions = (local: readonly LineChange[], remote: readonly LineChange[]): Region[] => {
  const all = [
    ...local.map((change) => ({ change, side: 'local' as const })),
    ...remote.map((change) => ({ change, side: 'remote' as const })),
  ].sort((a, b) => a.change.start - b.change.start || a.change.end - b.change.end)
  const found: Region[] = []
  for (const { change, side } of all) {
    const last = found[found.length - 1]
    if (last && collide(last, change)) {
      last.start = Math.min(last.start, change.start)
      last.end = Math.max(last.end, change.end)
      last[side].push(change)
    } else {
      found.push({ start: change.start, end: change.end, local: side === 'local' ? [change] : [], remote: side === 'remote' ? [change] : [] })
    }
  }
  return found
}

/** `base[start, end)` with one side's changes inside the region applied. */
const applyWithin = (base: readonly string[], region: Region, changes: readonly LineChange[]): string[] => {
  const out: string[] = []
  let at = region.start
  for (const change of changes) {
    out.push(...base.slice(at, change.start), ...change.lines)
    at = change.end
  }
  out.push(...base.slice(at, region.end))
  return out
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((line, index) => line === b[index])

export const mergeText = (base: Uint8Array, local: Uint8Array, remote: Uint8Array): MergeResult => {
  const parsed = [parse(base), parse(local), parse(remote)] as const
  for (const side of parsed) {
    if (typeof side === 'string') return { type: 'refused', reason: side }
  }
  const [b, l, r] = parsed as unknown as [ParsedText, ParsedText, ParsedText]
  const localChanges = diffLines(b.lines, l.lines, MAX_EDITS)
  const remoteChanges = diffLines(b.lines, r.lines, MAX_EDITS)
  if (localChanges === null || remoteChanges === null) return { type: 'refused', reason: 'too_complex' }

  const lines: string[] = []
  let at = 0
  for (const region of regions(localChanges, remoteChanges)) {
    lines.push(...b.lines.slice(at, region.start))
    const mine = applyWithin(b.lines, region, region.local)
    const theirs = applyWithin(b.lines, region, region.remote)
    if (region.local.length > 0 && region.remote.length > 0 && !sameLines(mine, theirs)) return { type: 'conflict' }
    lines.push(...(region.local.length > 0 ? mine : theirs))
    at = region.end
  }
  lines.push(...b.lines.slice(at))

  const eol = pick(b.eol, l.eol, r.eol) ?? l.eol ?? r.eol ?? b.eol ?? '\n'
  const bom = pick(b.bom, l.bom, r.bom)
  const finalNewline = lines.length > 0 && pick(b.finalNewline, l.finalNewline, r.finalNewline)
  const text = `${bom ? BOM : ''}${lines.join(eol)}${finalNewline ? eol : ''}`
  return { type: 'merged', text, bytes: encoder.encode(text) }
}
