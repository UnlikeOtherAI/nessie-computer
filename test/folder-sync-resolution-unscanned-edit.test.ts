import assert from 'node:assert/strict'
import test from 'node:test'

import { createMatrix } from './support/folder-sync-sim/matrix-world.js'

for (const resolution of ['keep_mine', 'keep_nessie'] as const) {
  test(`${resolution} refuses a canonical save made after the last scan and preserves it in the copy`, async (t) => {
    const w = await createMatrix()
    t.after(w.cleanup)
    const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null,
      kind: 'document', title: 'Plan', content: 'base\n' })
    await w.start()
    w.server.actor.edit(doc.id, 'Nessie wording\n')
    await w.pc.write('Projects/Plan.md', 'first local wording\n')
    await w.pc.settle()
    await w.pc.settle()
    const [row] = w.pc.openRows()
    assert.ok(row?.copy)
    const fresh = 'a save the scanner has not seen\n'
    await w.pc.write('Projects/Plan.md', fresh)
    await w.pc.command({ command: 'resolve', clientConflictId: row.clientConflictId, resolution })
    await w.pc.settle()
    const reopened = w.pc.openRows().find((item) => item.clientConflictId === row.clientConflictId)
    assert.ok(reopened, 'the stale choice must not close the row')
    assert.equal(await w.pc.read(row.copy.relPath), fresh)
    assert.equal(w.server.text(w.server.pages.get(row.copy.pageId!)!), fresh)
    assert.equal(w.server.text(doc), 'Nessie wording\n', 'the remote canonical document is unchanged')
  })
}
