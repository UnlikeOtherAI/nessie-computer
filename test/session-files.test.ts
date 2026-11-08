import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createJsonExclusive } from '../src/coding-session/session-files.js'

test('exclusive claim creation has one winner and never replaces its value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-exclusive-'))
  try {
    const path = join(root, 'claim.json')
    const results = await Promise.all(Array.from({ length: 16 }, (_, owner) => createJsonExclusive(path, { owner })))
    assert.equal(results.filter(Boolean).length, 1)
    const winner = results.indexOf(true)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { owner: winner })
    assert.equal(await createJsonExclusive(path, { owner: 'replacement' }), false)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { owner: winner })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a deleted claim can be created again after its last open handle closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-exclusive-deleted-'))
  const path = join(root, 'claim.json')
  const previous = await open(path, 'wx', 0o600)
  let closePrevious: Promise<void> | undefined
  try {
    await unlink(path)
    closePrevious = new Promise<void>((resolve, reject) => {
      setTimeout(() => { void previous.close().then(resolve, reject) }, 75)
    })
    assert.equal(await createJsonExclusive(path, { owner: 'next' }), true)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { owner: 'next' })
  } finally {
    if (closePrevious) await closePrevious
    else await previous.close()
    await rm(root, { recursive: true, force: true })
  }
})
