import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  flushSandboxDrafts,
  ingestGuestDrafts,
  registerSandboxDraftSource,
  releaseSandboxDraftSource,
  type GuestDraftReader,
} from '../src/guest-draft-ingest.js'
import {
  GUEST_DRAFT_READ_MAX_BYTES,
  parseDraftChunk,
  parseDraftScan,
  type GuestDraftEntry,
} from '../src/guest-vm-payloads.js'
import { WINDOWS_SYMLINK_SKIP } from './windows-prerequisites.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * Replays what a real guest would say. `files` is the draft's own content, so
 * the reader's chunking is the same paging the guest performs.
 */
const guestSaying = (entries: GuestDraftEntry[], files: Record<string, string>): GuestDraftReader & {
  reads: string[]
} => ({
  reads: [] as string[],
  readDraft(path: string, offset: number) {
    this.reads.push(`${path}@${offset}`)
    const content = Buffer.from(files[path] ?? '', 'utf8')
    const bytes = content.subarray(offset, offset + 8)
    return Promise.resolve({ bytes, eof: offset + bytes.byteLength >= content.byteLength })
  },
  scanDrafts(cursor: number) {
    const page = entries.slice(cursor, cursor + 2)
    return Promise.resolve({
      entries: page,
      ...(cursor + 2 < entries.length ? { next: cursor + 2 } : {}),
    })
  },
})

const overlay = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-draft-'))
  await mkdir(join(root, 'workspace'), { mode: 0o700 })
  return join(root, 'workspace')
}

test('the host parses exactly what the Go guest encodes', async () => {
  // The same bytes executor/guest/drafts_test.go asserts its encoder produces.
  const scan = parseDraftScan(await readFile(join(FIXTURES, 'guest-draft-scan.json')))
  assert.deepEqual(scan, {
    entries: [
      { kind: 'dir', mode: 0o700, path: 'src', size: 0 },
      { kind: 'file', mode: 0o600, path: 'src/main.ts', size: 23 },
      { kind: 'dir', mode: 0o755, opaque: true, path: 'build', size: 0 },
      { kind: 'whiteout', mode: 0, path: 'stale.txt', size: 0 },
    ],
    next: 4,
  })
  const chunk = parseDraftChunk(await readFile(join(FIXTURES, 'guest-draft-chunk.json')))
  assert.equal(chunk.bytes.toString('utf8'), 'export const value = 1\n')
  assert.equal(chunk.eof, true)
})

test('a malformed or oversized draft answer is refused rather than trusted', () => {
  const refusals = [
    '{"entries":[],"version":2}',
    '{"entries":[{"kind":"link","mode":0,"path":"a","size":0}],"version":1}',
    '{"entries":[{"kind":"file","mode":4096,"path":"a","size":1}],"version":1}',
    // A whiteout or directory can carry no size, and only a directory is opaque.
    '{"entries":[{"kind":"whiteout","mode":0,"path":"a","size":5}],"version":1}',
    '{"entries":[{"kind":"file","mode":384,"opaque":true,"path":"a","size":5}],"version":1}',
    '{"entries":[{"extra":1,"kind":"file","mode":384,"path":"a","size":5}],"version":1}',
    '{"entries":[],"next":-1,"version":1}',
    'not json',
  ]
  for (const refusal of refusals) {
    assert.throws(() => parseDraftScan(Buffer.from(refusal)), /workspace draft/, refusal)
  }
  assert.throws(
    () => parseDraftChunk(Buffer.from(JSON.stringify({
      bytes: Buffer.alloc(GUEST_DRAFT_READ_MAX_BYTES + 1).toString('base64'),
      eof: true,
      version: 1,
    }))),
    /workspace draft/,
  )
})

test('a draft is streamed into the run overlay, deletions included', async () => {
  const workspace = await overlay()
  try {
    await mkdir(join(workspace, 'build'), { mode: 0o700 })
    await writeFile(join(workspace, 'build', 'old.js'), 'stale output')
    await writeFile(join(workspace, 'stale.txt'), 'to be removed')
    const reader = guestSaying([
      { kind: 'dir', mode: 0o700, path: 'src', size: 0 },
      { kind: 'file', mode: 0o600, path: 'src/main.ts', size: 23 },
      { kind: 'dir', mode: 0o755, opaque: true, path: 'build', size: 0 },
      { kind: 'whiteout', mode: 0, path: 'stale.txt', size: 0 },
    ], { 'src/main.ts': 'export const value = 1\n' })
    const applied = await ingestGuestDrafts(reader, workspace)
    assert.deepEqual(applied, { bytes: 23, files: 4 })
    assert.equal(await readFile(join(workspace, 'src', 'main.ts'), 'utf8'), 'export const value = 1\n')
    // The file was paged in 8-byte chunks, which is the guest's own bound.
    assert.deepEqual(reader.reads, ['src/main.ts@0', 'src/main.ts@8', 'src/main.ts@16'])
    // The deleted file is gone, and the emptied directory kept none of its
    // contents, so a review reports both as deleted.
    await assert.rejects(stat(join(workspace, 'stale.txt')), /ENOENT/)
    assert.deepEqual(await readdir(join(workspace, 'build')), [])
    // Draft ingest is idempotent: a review may ask for it again mid-session.
    await ingestGuestDrafts(reader, workspace)
    assert.equal(await readFile(join(workspace, 'src', 'main.ts'), 'utf8'), 'export const value = 1\n')
  } finally {
    await rm(dirname(workspace), { force: true, recursive: true })
  }
})

test('a guest cannot name a path outside the run overlay', async () => {
  const workspace = await overlay()
  try {
    for (const path of ['../escape.txt', '/etc/passwd', 'a/../../escape.txt', '.nessie-executor-promotions/x']) {
      await assert.rejects(
        ingestGuestDrafts(
          guestSaying([{ kind: 'file', mode: 0o600, path, size: 1 }], { [path]: 'x' }),
          workspace,
        ),
        /Workspace path|may not access executor journal|relative/,
        path,
      )
    }
    await assert.rejects(stat(join(dirname(workspace), 'escape.txt')), /ENOENT/)
  } finally {
    await rm(dirname(workspace), { force: true, recursive: true })
  }
})

test('a symbolic link already in the overlay cannot redirect a draft write', { skip: WINDOWS_SYMLINK_SKIP }, async () => {
  const workspace = await overlay()
  const outside = join(dirname(workspace), 'outside.txt')
  try {
    await writeFile(outside, 'host content')
    await symlink(outside, join(workspace, 'link.txt'))
    await assert.rejects(
      ingestGuestDrafts(
        guestSaying([{ kind: 'file', mode: 0o600, path: 'link.txt', size: 1 }], { 'link.txt': 'guest' }),
        workspace,
      ),
      /ELOOP|symbolic/,
    )
    assert.equal(await readFile(outside, 'utf8'), 'host content')
  } finally {
    await rm(dirname(workspace), { force: true, recursive: true })
  }
})

test('a guest that never terminates its listing is stopped', async () => {
  const workspace = await overlay()
  try {
    const endless: GuestDraftReader = {
      readDraft: () => Promise.resolve({ bytes: Buffer.alloc(0), eof: true }),
      scanDrafts: (cursor) => Promise.resolve({ entries: [], next: cursor + 1 }),
    }
    await assert.rejects(ingestGuestDrafts(endless, workspace), /unterminated/)
    const stuck: GuestDraftReader = {
      readDraft: () => Promise.resolve({ bytes: Buffer.alloc(0), eof: true }),
      scanDrafts: () => Promise.resolve({ entries: [], next: 0 }),
    }
    await assert.rejects(ingestGuestDrafts(stuck, workspace), /non-advancing/)
  } finally {
    await rm(dirname(workspace), { force: true, recursive: true })
  }
})

test('review reaches a live block-mode session through its registered flush', async () => {
  let flushes = 0
  const flush = async (): Promise<void> => { flushes += 1 }
  // Nothing registered: review of a virtiofs run, or of no run at all, is a
  // no-op rather than an error.
  await flushSandboxDrafts('11111111-1111-4111-8111-111111111111')
  registerSandboxDraftSource('11111111-1111-4111-8111-111111111111', flush)
  await flushSandboxDrafts('11111111-1111-4111-8111-111111111111')
  assert.equal(flushes, 1)
  // A stale flush never displaces the live one, and releasing is exact.
  releaseSandboxDraftSource('11111111-1111-4111-8111-111111111111', async () => undefined)
  await flushSandboxDrafts('11111111-1111-4111-8111-111111111111')
  assert.equal(flushes, 2)
  releaseSandboxDraftSource('11111111-1111-4111-8111-111111111111', flush)
  await flushSandboxDrafts('11111111-1111-4111-8111-111111111111')
  assert.equal(flushes, 2)
})
