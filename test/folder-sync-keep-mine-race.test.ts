import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import test from 'node:test'

import { createMatrix } from './support/folder-sync-sim/matrix-world.js'
import { Prng } from './support/folder-sync-sim/prng.js'

/**
 * The rehearsal's suspected lost update (T12): a conflict, Keep mine on one
 * computer, then non-overlapping saves on both. Seeded runs vary the daemon
 * restart before the choice, who chooses, when the second save lands (before,
 * during or after the first one's download, including the instant after its
 * install), and the order and scope of passes. Every save is made by an editor
 * that holds the file as it is on disk when it saves, so both edits must end up
 * in Nessie's head and on both computers — merged, never replaced.
 *
 * `T12_SEEDS=<n> T12_FIRST=<n>` runs a larger batch; a failure names its seed.
 */

const K0 = '# Shared plan\n\nline one\n\nline two\n\nline three\n\nline four\n\nline five\n'
const FILE = 'Projects/Plan.md'
const SEEDS = Number(process.env.T12_SEEDS ?? 6)
const FIRST = Number(process.env.T12_FIRST ?? 1)

const require = createRequire(import.meta.url)
const fsp = require('node:fs/promises') as typeof import('node:fs/promises')

const replace = (text: string, prefix: string, line: string) =>
  text.split('\n').map((l) => (l.startsWith(prefix) ? line : l)).join('\n')

/** Run `save` once, right after the next rename onto a path under `dir` ending in `name`. */
const saveAfterInstall = (dir: string, name: string, save: () => Promise<void>): (() => void) => {
  const original = fsp.rename
  const restore = () => {
    fsp.rename = original
    syncBuiltinESMExports()
  }
  fsp.rename = (async (from, to) => {
    await original(from, to)
    const target = String(to).toLowerCase()
    if (target.includes(dir.toLowerCase()) && target.endsWith(name.toLowerCase())) {
      restore()
      await save()
    }
  }) as typeof original
  syncBuiltinESMExports()
  return restore
}

for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
  test(`Keep mine, then non-overlapping saves on both computers merge (seed ${seed})`, async (t) => {
    const rand = new Prng(seed)
    const w = await createMatrix({ computers: 2 })
    t.after(w.cleanup)
    const [A, B] = w.computers as [typeof w.pc, typeof w.pc]
    const doc = w.server.actor.create({ spaceId: w.space.id, parentPageId: null, kind: 'document', title: 'Plan', content: K0 })
    await w.start()

    // Overlapping saves: the second to arrive keeps a conflicted copy.
    const [first, second] = rand.chance(0.5) ? [A, B] : [B, A]
    await first.write(FILE, replace(K0, 'line three', `line three — ${first.label}`))
    await first.settle()
    await second.write(FILE, replace(K0, 'line three', `line three — ${second.label}`))
    await second.settle()
    await second.settle()
    const [row] = second.openRows()
    assert.ok(row?.copy, 'the second computer keeps a conflicted copy')
    await first.settle()
    if (rand.chance(0.5)) second.restart()
    const occurredAt = second.view.conflicts.get(row.clientConflictId)!.occurredAt
    second.view.instructions = {
      heldDeletes: null, resolveConflicts: [{ clientConflictId: row.clientConflictId, resolution: 'keep_mine', expectedOccurredAt: occurredAt }],
    }
    await second.settle()
    second.view.instructions = { heldDeletes: null, resolveConflicts: [] }
    await w.settleAll()
    assert.equal(await B.read(FILE), await A.read(FILE), 'converged after Keep mine')

    // Non-overlapping saves: X now, Y after a gap; passes in a random order.
    const [x, y] = rand.chance(0.5) ? [A, B] : [B, A]
    const lineX = `line one — ${x.label} ${seed}`
    const lineY = `line five — ${y.label} ${seed}`
    const saveY = async () => writeFile(y.path(FILE), replace(await readFile(y.path(FILE), 'utf8'), 'line five', lineY))
    await x.write(FILE, replace(await x.read(FILE), 'line one', lineX))
    const gapMs = rand.pick([0, 0, 500, 1_500, 2_500, 4_000, 6_000])
    const onInstall = rand.chance(0.3)
    let saved = false
    let restore = onInstall ? saveAfterInstall(y.replica.tmp, 'Plan.md', async () => { saved = true; await saveY() }) : null
    let elapsed = 0
    const scopes: Array<string[] | null> = [null, [], ['Projects']]
    try {
      for (let step = 0; step < 14; step += 1) {
        if (!saved && !onInstall && elapsed >= gapMs) {
          saved = true
          await saveY()
        }
        const advance = rand.between(0, 1_500)
        w.advance(advance)
        elapsed += advance
        const outcome = await rand.pick([A, B]).replica.pass({ scope: rand.pick(scopes) })
        if (outcome.kind === 'failed') throw outcome.error
      }
    } finally {
      restore?.()
      restore = null
    }
    if (!saved) {
      saved = true
      await saveY()
    }
    await w.settleAll()

    const head = w.server.text(doc)
    assert.ok(head.includes(lineX) && head.includes(lineY), `seed ${seed}: both saves are in Nessie's head\n${head}`)
    assert.equal(await A.read(FILE), head, `seed ${seed}: ${A.label} shows the head`)
    assert.equal(await B.read(FILE), head, `seed ${seed}: ${B.label} shows the head`)
    assert.deepEqual([...A.openRows(), ...B.openRows()].map((open) => open.reason), [], `seed ${seed}: no new conflict`)
    assert.deepEqual(w.server.audit.violations, [])
  })
}
