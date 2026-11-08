import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { countExistingFiles, readMarker, syncRootRefusal, writeMarker } from '../src/folder-sync/config.js'
import { chooseTeamFolder, foldersOverlap, teamFolderCandidates } from '../src/folder-sync/team-folder.js'

/**
 * Several teams share one main folder, each in `<Organisation>/<Team>`
 * (path mapping rule 8). Named once, then fixed; a clash with another sync's
 * folder in the same root takes the executor's short tag.
 */

const ID = 'abcdef12-0000-4000-8000-000000000001'
const names = { organizationName: 'UnlikeOtherAI', teamName: 'Platform' }

const tempRoot = async (t: test.TestContext): Promise<string> => {
  const tmp = await mkdtemp(join(tmpdir(), 'nessie-team-folder-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const root = join(tmp, 'Nessie')
  await mkdir(root)
  return root
}

/** Another team's sync in `root`, holding `teamFolder`. */
const otherSync = (root: string, teamFolder: string) => writeMarker(root, {
  syncId: randomUUID(), executorId: randomUUID(), teamFolder, createdAt: '2026-11-01T10:00:00.000Z',
})

test('a team folder is the organisation, then the team, each cleaned like any folder', () => {
  assert.deepEqual(teamFolderCandidates(names, ID), [
    'UnlikeOtherAI/Platform', 'UnlikeOtherAI/Platform abcdef', 'UnlikeOtherAI abcdef/Platform', 'UnlikeOtherAI abcdef/Platform abcdef',
  ])
  assert.equal(teamFolderCandidates({ organizationName: 'Acme: Labs/EU', teamName: 'R&D. ' }, ID)[0], 'Acme_ Labs_EU/R&D')
  assert.equal(teamFolderCandidates({ organizationName: '.hidden', teamName: 'Drafts.tmp' }, ID)[0], '_.hidden/Drafts.tmp_')
})

test('a new team in an empty root, and a second team of the same organisation beside it, take plain names', async (t) => {
  const root = await tempRoot(t)
  assert.equal(await chooseTeamFolder(root, names, ID), 'UnlikeOtherAI/Platform')
  await otherSync(root, 'UnlikeOtherAI/Research')
  await otherSync(root, 'Acme/Platform')
  assert.equal(await chooseTeamFolder(root, names, ID), 'UnlikeOtherAI/Platform')
})

test('the same team folder held by another sync takes the short tag on the team segment', async (t) => {
  const root = await tempRoot(t)
  await otherSync(root, 'unlikeotherai/PLATFORM')
  assert.equal(await chooseTeamFolder(root, names, ID), 'UnlikeOtherAI/Platform abcdef')
})

test('an older one-segment team folder named like the organisation puts the tag on the organisation', async (t) => {
  const root = await tempRoot(t)
  await otherSync(root, 'UnlikeOtherAI')
  assert.equal(await chooseTeamFolder(root, names, ID), 'UnlikeOtherAI abcdef/Platform')
})

test('a team folder never holds, or sits inside, the folder of a sync whose root is above it', async (t) => {
  const root = await tempRoot(t)
  // A sync rooted inside this root's organisation folder whose team folder this team's would hold.
  await mkdir(join(root, 'UnlikeOtherAI'), { recursive: true })
  await otherSync(join(root, 'UnlikeOtherAI'), 'Platform/Engineering')
  assert.equal(await chooseTeamFolder(root, names, ID), 'UnlikeOtherAI/Platform abcdef')
  // A sync rooted above this root whose team folder this one would sit inside.
  const inner = join(root, 'Acme')
  await mkdir(inner)
  await otherSync(root, 'Acme/UnlikeOtherAI')
  assert.equal(await chooseTeamFolder(inner, names, ID), 'UnlikeOtherAI abcdef/Platform')
  assert.equal(foldersOverlap(join(root, 'A', 'B'), join(root, 'a')), true)
  assert.equal(foldersOverlap(join(root, 'A', 'B'), join(root, 'A', 'C')), false)
})

test('a folder inside another team\'s two-segment folder is refused; its organisation folder is not', async (t) => {
  const root = await tempRoot(t)
  await otherSync(root, 'UnlikeOtherAI/Platform')
  await mkdir(join(root, 'UnlikeOtherAI', 'Platform', 'Projects'), { recursive: true })
  const context = { workspaceFolders: [], stateDir: join(root, '..', 'state', ID), executorId: ID, home: join(root, '..', 'home') }
  for (const inside of [join(root, 'UnlikeOtherAI', 'Platform'), join(root, 'UnlikeOtherAI', 'Platform', 'Projects')]) {
    assert.equal(await syncRootRefusal(inside, context), 'root_inside_other_sync', inside)
  }
  assert.equal(await syncRootRefusal(join(root, 'UnlikeOtherAI'), context), null)
  assert.equal(await syncRootRefusal(root, context), null)
})

test('files already in a shared main folder count only when they are not another team\'s', async (t) => {
  const root = await tempRoot(t)
  await otherSync(root, 'UnlikeOtherAI/Platform')
  await otherSync(root, 'Old team')
  await mkdir(join(root, 'UnlikeOtherAI', 'Platform', 'Projects'), { recursive: true })
  await writeFile(join(root, 'UnlikeOtherAI', 'Platform', 'Projects', 'plan.md'), 'theirs\n')
  await mkdir(join(root, 'Old team'))
  await writeFile(join(root, 'Old team', 'notes.md'), 'theirs\n')
  assert.equal(await countExistingFiles(root, ID), 0)
  // Another root inside this one, with its own mirror.
  await mkdir(join(root, 'Elsewhere', 'Acme', 'Sales'), { recursive: true })
  await otherSync(join(root, 'Elsewhere'), 'Acme/Sales')
  await writeFile(join(root, 'Elsewhere', 'Acme', 'Sales', 'deal.md'), 'theirs\n')
  assert.equal(await countExistingFiles(root, ID), 0)
  await writeFile(join(root, 'UnlikeOtherAI', 'loose.txt'), 'mine\n')
  assert.equal(await countExistingFiles(root, ID), 1)
})

test('a marker whose team folder is not one or two clean names is not this engine\'s', async (t) => {
  const root = await tempRoot(t)
  for (const teamFolder of ['../outside', 'a/b/c', 'a\\b', '']) {
    const executorId = randomUUID()
    await writeFile(join(root, `.nessie-sync-${executorId}`), JSON.stringify({ syncId: randomUUID(), executorId, teamFolder }))
    assert.equal(await readMarker(root, executorId), null, teamFolder)
  }
  const old = randomUUID()
  await writeMarker(root, { syncId: randomUUID(), executorId: old, teamFolder: 'Platform', createdAt: '2026-01-01T00:00:00.000Z' })
  assert.equal((await readMarker(root, old))?.teamFolder, 'Platform')
})
