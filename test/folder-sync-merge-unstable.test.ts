import assert from 'node:assert/strict'
import test from 'node:test'

import { createSyncHarness } from './support/folder-sync-harness.js'

const text = 'one\ntwo\nthree\nfour\nfive\n'

for (const gapMs of [0, 500, 1_000, 1_500, 1_900, 2_100, 3_000]) {
  test(`a local edit made ${gapMs} ms before a pass that sees a remote edit keeps both edits`, async (t) => {
    const h = await createSyncHarness()
    t.after(h.cleanup)
    const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Plan', content: text })
    await h.enable()
    await h.settle()
    // Another computer's edit reaches Nessie while this person saves theirs.
    h.server.actor.edit(doc.id, text.replace('one', 'one PC'))
    await h.write('Projects/Plan.md', text.replace('five', 'five laptop'))
    h.advance(gapMs)
    await h.engine.runPass({ scope: null })
    await h.settle()
    const server = h.server.text(h.server.pages.get(doc.id))
    const local = await h.read('Projects/Plan.md')
    const copies = [...h.server.pages.values()].filter((page) => page.title.includes('conflicted copy'))
    const kept = (needle: string) =>
      server.includes(needle) || copies.some((page) => h.server.text(page).includes(needle))
    assert.ok(kept('one PC'), `the other computer's edit survives: ${JSON.stringify(server)}`)
    assert.ok(kept('five laptop'), `this computer's edit survives: ${JSON.stringify(server)}`)
    assert.equal(local, server)
  })
}
