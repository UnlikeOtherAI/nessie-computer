import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { writeFile } from 'node:fs/promises'
import test from 'node:test'

import { createMatrix } from './support/folder-sync-sim/matrix-world.js'

/**
 * A save that lands the moment after sync put Nessie's version on disk. The
 * entry used to be recorded with the version's hash and the file's *new*
 * stat, and the base text read from the new bytes: the scanner then trusted
 * that stat forever, so the save never uploaded, and a later merge would have
 * run against the wrong ancestor. The record now hashes what it records.
 */

const require = createRequire(import.meta.url)
const fsp = require('node:fs/promises') as typeof import('node:fs/promises')

/** Run `after` once, right after the first rename that lands on `target`. */
const afterRenameOnto = (target: string, after: () => Promise<void>): void => {
  const original = fsp.rename
  fsp.rename = (async (from, to) => {
    await original(from, to)
    if (String(to).toLowerCase().endsWith(target.toLowerCase())) {
      fsp.rename = original
      syncBuiltinESMExports()
      await after()
    }
  }) as typeof original
  syncBuiltinESMExports()
}

for (const kind of ['document', 'file'] as const) {
  test(`a ${kind} saved right after a download landed is uploaded, not taken for the download`, async (t) => {
    const w = await createMatrix({ computers: 2 })
    t.after(w.cleanup)
    const [pc, laptop] = w.computers as [typeof w.pc, typeof w.pc]
    const title = kind === 'document' ? 'Plan' : 'plan.txt'
    const path = kind === 'document' ? 'Projects/Plan.md' : 'Projects/plan.txt'
    const page = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind, title, content: 'one\ntwo\nthree\n' })
    await w.start()
    await pc.write(path, 'one PC\ntwo\nthree\n')
    await pc.settle()
    afterRenameOnto(path.split('/').pop()!, () => writeFile(laptop.path(path), 'one PC\ntwo\nthree laptop\n'))
    await laptop.settle()
    await laptop.settle()
    await w.settleAll()
    assert.equal(await laptop.read(path), 'one PC\ntwo\nthree laptop\n', 'the save stays on the laptop')
    assert.equal(w.server.text(page), 'one PC\ntwo\nthree laptop\n', 'the laptop save reached Nessie')
    assert.equal(await pc.read(path), 'one PC\ntwo\nthree laptop\n')
    assert.deepEqual(w.server.audit.violations, [])
  })
}

test('an edit made on top of a save that raced the download merges against the true ancestor', async (t) => {
  const w = await createMatrix({ computers: 2 })
  t.after(w.cleanup)
  const [pc, laptop] = w.computers as [typeof w.pc, typeof w.pc]
  const page = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Plan', content: 'a\nb\nc\nd\ne\n' })
  await w.start()
  await pc.write('Projects/Plan.md', 'a PC\nb\nc\nd\ne\n')
  await pc.settle()
  // The laptop's save lands on top of the download, then the PC edits again
  // before the laptop's next pass: both later edits must survive.
  afterRenameOnto('Plan.md', () => writeFile(laptop.path('Projects/Plan.md'), 'a PC\nb\nc laptop\nd\ne\n'))
  await laptop.pass()
  await pc.write('Projects/Plan.md', 'a PC\nb\nc\nd\ne PC\n')
  await pc.settle()
  await w.settleAll()
  const head = w.server.text(page)
  assert.ok(head.includes('c laptop'), `the laptop save survives:\n${head}`)
  assert.ok(head.includes('e PC'), `the PC edit survives:\n${head}`)
  assert.equal(await laptop.read('Projects/Plan.md'), head)
  assert.deepEqual(w.server.audit.violations, [])
})
