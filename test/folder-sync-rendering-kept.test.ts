import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { folderSyncPaths } from '../src/folder-sync/state-files.js'
import { listTrash } from '../src/folder-sync/trash-book.js'
import { createSyncHarness } from './support/folder-sync-harness.js'

/**
 * Nessie stores its own rendering of what a computer sends: a JPEG re-encoded
 * with its EXIF/GPS stripped, Markdown whose front matter, footnotes or raw
 * HTML come back rewritten. The file then converges on Nessie's bytes (A11) —
 * but the person's original is kept in the local trash first, never lost.
 */

const trashedBytes = async (stateDir: string, relPath: string): Promise<Buffer[]> => {
  const dir = join(folderSyncPaths(stateDir).trash, '.entries')
  const found: Buffer[] = []
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as { relPath: string; trashPath: string }
    if (record.relPath === relPath) found.push(await readFile(record.trashPath))
  }
  return found
}

test('a re-encoded image and a re-written document converge on Nessie\'s bytes; the originals stay in the trash', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  // Front matter comes back as a heading; a photo loses its metadata byte.
  h.server.render = (markdown) => markdown.replace(/^---\ntitle: (.*)\n---\n/u, '---\n\n## title: $1\n')
  h.server.storeFile = (bytes, name) => (name.endsWith('.jpg') ? bytes.subarray(0, bytes.length - 1) : bytes)
  h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Trip', content: 'Day one\n' })
  await h.enable()
  await h.settle()
  const note = '---\ntitle: Trip\n---\nDay one\n'
  const photo = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0x47])
  await h.write('Projects/Trip.md', note)
  await h.write('Projects/photo.jpg', photo)
  await h.settle()

  assert.equal(await h.read('Projects/Trip.md'), '---\n\n## title: Trip\nDay one\n', 'the file shows Nessie\'s rendering')
  assert.deepEqual([...await readFile(h.path('Projects/photo.jpg'))], [0xff, 0xd8, 1, 2, 3])
  assert.deepEqual((await trashedBytes(h.stateDir, 'Projects/Trip.md')).map((bytes) => bytes.toString()), [note])
  assert.deepEqual((await trashedBytes(h.stateDir, 'Projects/photo.jpg')).map((bytes) => [...bytes]), [[...photo]])
  const listed = (await listTrash(folderSyncPaths(h.stateDir))).map((entry) => entry.relPath).sort()
  assert.deepEqual(listed, ['Projects/Trip.md', 'Projects/photo.jpg'], 'Deleted files lists both originals')
  assert.equal((await h.state()).state, 'up_to_date')
})

test('bytes Nessie stores unchanged are not copied to the trash', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  await h.enable()
  await h.settle()
  await h.write('Projects/plain.md', 'plain\n')
  await h.settle()
  assert.deepEqual(await listTrash(folderSyncPaths(h.stateDir)), [])
})
