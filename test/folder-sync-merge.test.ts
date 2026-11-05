import assert from 'node:assert/strict'
import test from 'node:test'

import { FOLDER_SYNC_MERGE_MAX_BYTES } from '@nessie/executor-protocol'

import { diffLines } from '../src/folder-sync/line-diff.js'
import { mergeText, type MergeResult } from '../src/folder-sync/merge.js'

const bytes = (text: string) => new TextEncoder().encode(text)
const merge = (base: string, local: string, remote: string): MergeResult =>
  mergeText(bytes(base), bytes(local), bytes(remote))
const merged = (base: string, local: string, remote: string): string => {
  const result = merge(base, local, remote)
  assert.equal(result.type, 'merged', JSON.stringify(result))
  return result.type === 'merged' ? result.text : ''
}

test('non-overlapping edits on both sides merge cleanly', () => {
  assert.equal(merged('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n'), 'A\nb\nc\nd\nE\n')
})

test('adjacent (touching, not overlapping) line edits merge', () => {
  assert.equal(merged('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nC\n'), 'a\nB\nC\n')
})

test('one side unchanged takes the other side whole', () => {
  assert.equal(merged('a\nb\n', 'a\nb\n', 'x\ny\nz\n'), 'x\ny\nz\n')
  assert.equal(merged('a\nb\n', 'x\n', 'a\nb\n'), 'x\n')
})

test('identical changes on both sides are taken once', () => {
  assert.equal(merged('a\nb\nc\n', 'a\nX\nc\n', 'a\nX\nc\n'), 'a\nX\nc\n')
})

test('overlapping replacements are a conflict', () => {
  assert.deepEqual(merge('a\nb\nc\n', 'a\nLOCAL\nc\n', 'a\nREMOTE\nc\n'), { type: 'conflict' })
  assert.deepEqual(merge('a\nb\nc\nd\n', 'a\nX\nY\nd\n', 'a\nb\nZ\nd\n'), { type: 'conflict' })
})

test('simultaneous insertion at one anchor is a conflict (order would be a guess)', () => {
  assert.deepEqual(merge('a\nb\n', 'a\nmine\nb\n', 'a\ntheirs\nb\n'), { type: 'conflict' })
})

test('an insertion touching the other side\'s modified line is a conflict', () => {
  assert.deepEqual(merge('a\nb\nc\n', 'a\nnew\nb\nc\n', 'a\nB\nc\n'), { type: 'conflict' })
})

test('deletion versus modification of the same line is a conflict', () => {
  assert.deepEqual(merge('a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n'), { type: 'conflict' })
})

test('deletion on one side and an edit elsewhere merge', () => {
  assert.equal(merged('a\nb\nc\nd\n', 'a\nc\nd\n', 'a\nb\nc\nD\n'), 'a\nc\nD\n')
})

test('repeated lines are aligned by position, not by first match', () => {
  const base = 'x\nx\nx\nx\nx\n'
  assert.equal(merged(base, 'x\nx\nL\nx\nx\nx\n', 'x\nx\nx\nx\nx\nR\n'), 'x\nx\nL\nx\nx\nx\nR\n')
})

test('empty files: base empty with one side adding, both empty, one side emptying', () => {
  assert.equal(merged('', 'hello\n', ''), 'hello\n')
  assert.equal(merged('', '', ''), '')
  assert.equal(merged('a\nb\n', '', 'a\nb\n'), '')
  assert.deepEqual(merge('', 'mine\n', 'theirs\n'), { type: 'conflict' })
})

test('no final newline: the property merges like a line and edits merge around it', () => {
  assert.equal(merged('a\nb', 'A\nb', 'a\nb\n'), 'A\nb\n')
  assert.equal(merged('a\nb\n', 'a\nb', 'a\nB\n'), 'a\nB')
  assert.equal(merged('a', 'a', 'a\nb'), 'a\nb')
})

test('CRLF is preserved when every side uses it', () => {
  assert.equal(merged('a\r\nb\r\nc\r\n', 'A\r\nb\r\nc\r\n', 'a\r\nb\r\nC\r\n'), 'A\r\nb\r\nC\r\n')
})

test('CRLF/LF per side: the side that changed the line ending wins it', () => {
  // Remote converted to LF and edited; local only edited: output is LF.
  assert.equal(merged('a\r\nb\r\nc\r\n', 'A\r\nb\r\nc\r\n', 'a\nb\nC\n'), 'A\nb\nC\n')
  // Local converted to CRLF; remote kept LF.
  assert.equal(merged('a\nb\n', 'a\r\nb\r\n', 'a\nB\n'), 'a\r\nB\r\n')
})

test('mixed line endings inside one input are refused, not normalised', () => {
  assert.deepEqual(merge('a\r\nb\n', 'a\r\nb\n', 'a\r\nB\n'), { type: 'refused', reason: 'mixed_line_endings' })
})

test('the byte-order mark is kept, and a side that added or removed it wins', () => {
  assert.equal(merged('﻿a\nb\n', '﻿A\nb\n', '﻿a\nB\n'), '﻿A\nB\n')
  assert.equal(merged('a\nb\n', '﻿a\nb\n', 'a\nB\n'), '﻿a\nB\n')
  const result = merge('﻿a\n', '﻿a\n', '﻿b\n')
  assert.ok(result.type === 'merged' && result.bytes[0] === 0xef && result.bytes[1] === 0xbb && result.bytes[2] === 0xbf)
})

test('Unicode is compared as bytes: NFC and NFD of one word are different lines', () => {
  assert.deepEqual(merge('Café\n', 'Café!\n', 'Café\n'), { type: 'conflict' })
  assert.equal(merged('😀\nb\n', '😀😀\nb\n', '😀\nβ\n'), '😀😀\nβ\n')
})

test('invalid UTF-8 (a lossy encoding) is refused', () => {
  const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])
  assert.deepEqual(mergeText(latin1, latin1, bytes('cafe\n')), { type: 'refused', reason: 'invalid_utf8' })
})

test('binary (a NUL byte) is refused', () => {
  assert.deepEqual(mergeText(new Uint8Array([1, 0, 2]), bytes('a'), bytes('b')), { type: 'refused', reason: 'binary' })
})

test('over 5 MiB is refused', () => {
  const big = new Uint8Array(FOLDER_SYNC_MERGE_MAX_BYTES + 1).fill(0x61)
  assert.deepEqual(mergeText(bytes('a'), big, bytes('a')), { type: 'refused', reason: 'too_large' })
})

test('the line diff returns the minimal changes and gives up past its bound', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'], 10), [{ start: 1, end: 2, lines: ['x'] }])
  assert.deepEqual(diffLines(['a'], ['a', 'b'], 10), [{ start: 1, end: 1, lines: ['b'] }])
  assert.deepEqual(diffLines([], [], 10), [])
  const many = Array.from({ length: 50 }, (_, index) => `line ${index}`)
  assert.equal(diffLines(many, many.map((line) => `${line}!`), 10), null)
})

test('a large file with scattered edits merges', () => {
  const base = Array.from({ length: 20_000 }, (_, index) => `line ${index}`)
  const local = [...base]
  local[100] = 'local edit'
  const remote = [...base]
  remote[19_000] = 'remote edit'
  const out = merged(`${base.join('\n')}\n`, `${local.join('\n')}\n`, `${remote.join('\n')}\n`).split('\n')
  assert.equal(out[100], 'local edit')
  assert.equal(out[19_000], 'remote edit')
})
