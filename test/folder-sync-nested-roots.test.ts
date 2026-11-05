import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { createMatrix } from './support/folder-sync-sim/matrix-world.js'

/**
 * Two teams' syncs on one computer (one executor each). A sync folder chosen
 * inside another team's synced folder would make that sync see this team's
 * mirror as its own new files and send them to its team — and this one the
 * other's. The root rule refuses it, and a scan never walks into a folder
 * that holds another sync's marker, however it got there.
 */

test('a folder inside another team\'s synced folder is refused as a sync folder; the shared root is not', async (t) => {
  const w = await createMatrix({ computers: 2 })
  t.after(w.cleanup)
  const [first, second] = w.computers as [typeof w.pc, typeof w.pc]
  w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Plan', content: 'p\n' })
  await first.enable()
  await first.settle()
  const inner = join(first.replica.teamDir(), 'Projects', 'Mirror of team 2')
  await mkdir(inner, { recursive: true })
  for (const root of [first.replica.teamDir(), inner]) {
    const answer = await second.command({ command: 'configure', root, enabled: true, acceptExistingFiles: true })
    assert.deepEqual(answer, { outcome: 'refused', reason: 'root_inside_other_sync' }, root)
  }
  // Beside it in the same root, each in its own team folder, is fine.
  const shared = await second.command({ command: 'configure', root: first.replica.root, enabled: true, acceptExistingFiles: true })
  assert.notEqual((shared as { reason?: string }).reason, 'root_inside_other_sync')
})

test('a scan never sends a folder that holds another sync\'s marker', async (t) => {
  const w = await createMatrix()
  t.after(w.cleanup)
  await w.start()
  // Another team's root that ended up inside this team's folder, with its mirror.
  const nested = w.pc.path('Projects/Other team root')
  await mkdir(join(nested, 'Team 2'), { recursive: true })
  await writeFile(join(nested, `.nessie-sync-${randomUUID()}`), JSON.stringify({ syncId: randomUUID(), teamFolder: 'Team 2' }))
  await writeFile(join(nested, 'Team 2', 'secret.md'), 'team 2 only\n')
  await w.pc.write('Projects/Ours/note.md', 'ours\n')
  await w.pc.settle()
  const titles = [...w.server.pages.values()].map((page) => page.title)
  assert.ok(titles.includes('Ours'), 'an ordinary new folder still syncs')
  assert.ok(!titles.includes('Other team root') && !titles.includes('Team 2') && !titles.includes('secret'), titles.join(', '))
  assert.equal((await w.pc.state()).state, 'up_to_date')
})
