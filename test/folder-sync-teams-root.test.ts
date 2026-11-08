import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { loadFolderSyncConfig, markerPath, saveFolderSyncConfig } from '../src/folder-sync/config.js'
import { runConsoleCommand } from '../src/folder-sync/sync-command.js'
import { createSyncHarness, testSecurity } from './support/folder-sync-harness.js'

/**
 * Several teams on one computer share one main folder, each in its own
 * `<Organisation>/<Team>` folder and each with its own switch. The engine's
 * names come from the handshake, or the pairing claim when Nessie does not
 * name the organisation; an older sync keeps its one-segment folder.
 */

const visible = (names: string[]) => names.filter((name) => !name.startsWith('.')).sort()

test('before it is on, a team says where its files will go; on, they go there', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Plan', content: 'p\n' })
  await h.pass()
  const off = await h.state()
  assert.equal(off.enabled, false)
  assert.equal(off.defaultRoot, h.root)
  assert.equal(off.teamFolder, 'UnlikeOtherAI/Platform')
  assert.equal(off.teamLabel, null, 'nothing is named before it is on')
  await h.enable()
  await h.settle()
  assert.equal(await readFile(join(h.root, 'UnlikeOtherAI', 'Platform', 'Projects', 'Plan.md'), 'utf8'), 'p\n')
  const on = await h.state()
  assert.equal(on.teamLabel, 'UnlikeOtherAI/Platform')
  assert.equal(on.teamFolder, 'UnlikeOtherAI/Platform')
})

test('two teams share one main folder, each in its own folder; one switched off leaves the other syncing', async (t) => {
  const platform = await createSyncHarness()
  t.after(platform.cleanup)
  const research = await createSyncHarness({ beside: platform })
  research.server.teamLabel = 'Research'
  platform.server.actor.create({ spaceId: platform.space.id, parentPageId: null, kind: 'document', title: 'Roadmap', content: 'r\n' })
  research.server.actor.create({ spaceId: research.space.id, parentPageId: null, kind: 'document', title: 'Paper', content: 'q\n' })
  await platform.enable()
  await platform.settle()

  // The second team is offered the folder the first already uses, and asked nothing about the first team's files.
  await research.pass()
  const offered = await research.state()
  assert.equal(offered.defaultRoot, platform.root)
  assert.equal(offered.teamFolder, 'UnlikeOtherAI/Research')
  const answer = await runConsoleCommand(research.context, {
    command: 'configure', root: offered.defaultRoot, enabled: true, acceptExistingFiles: false,
  })
  assert.equal(answer.outcome, 'applied')
  await research.settle()
  assert.deepEqual(visible(await readdir(join(platform.root, 'UnlikeOtherAI'))), ['Platform', 'Research'])
  assert.equal(await readFile(join(platform.root, 'UnlikeOtherAI', 'Research', 'Projects', 'Paper.md'), 'utf8'), 'q\n')

  // Neither team sends the other's files.
  await platform.settle()
  const titles = (h: typeof platform) => h.server.livePages().map((page) => page.title).sort()
  assert.deepEqual(titles(platform), ['Roadmap'])
  assert.deepEqual(titles(research), ['Paper'])

  // Research switched off: its folder stays, Platform keeps syncing.
  await runConsoleCommand(research.context, { command: 'configure', root: platform.root, enabled: false, acceptExistingFiles: false })
  await research.pass()
  assert.equal((await research.state()).state, 'off')
  await platform.write('Projects/Notes.txt', 'n\n')
  await platform.settle()
  assert.equal(platform.server.text(platform.server.find('Projects/Notes.txt')), 'n\n')
  assert.equal((await platform.state()).state, 'up_to_date')
  assert.equal(await readFile(join(platform.root, 'UnlikeOtherAI', 'Research', 'Projects', 'Paper.md'), 'utf8'), 'q\n')
})

test('a Nessie that does not name the organisation: the pairing claim names it', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  h.server.handshakeNamesOrganization = false
  await h.enable()
  await h.settle()
  assert.equal((await loadFolderSyncConfig(h.stateDir)).teamFolder, 'UnlikeOtherAI/Platform')
  assert.ok(h.server.calls.includes('pairing_connection'))
})

test('the handshake\'s organisation name is used when the claim cannot be read', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  h.server.faults = Array.from({ length: 5 }, () => ({ operation: 'pairing_connection', mode: 'refuse' as const, status: 503, code: 'DOWN' }))
  await h.enable()
  await h.settle()
  assert.equal((await loadFolderSyncConfig(h.stateDir)).teamFolder, 'UnlikeOtherAI/Platform')
})

test('with no organisation name to be had, nothing is named from a guess', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  h.server.handshakeNamesOrganization = false
  h.server.faults = Array.from({ length: 5 }, () => ({ operation: 'pairing_connection', mode: 'refuse' as const, status: 503, code: 'DOWN' }))
  await h.enable()
  await assert.rejects(h.pass())
  assert.equal((await loadFolderSyncConfig(h.stateDir)).teamFolder, null)
  h.server.faults = []
  await h.settle()
  assert.equal((await loadFolderSyncConfig(h.stateDir)).teamFolder, 'UnlikeOtherAI/Platform')
})

test('a sync named before teams shared a main folder keeps its one-segment folder, also when chosen again', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Old', content: 'o\n' })
  await h.enable()
  // As an earlier version left it: the team folder is the team's name alone.
  const config = await loadFolderSyncConfig(h.stateDir)
  await saveFolderSyncConfig(h.stateDir, { ...config, teamFolder: 'Platform' }, testSecurity)
  const marker = JSON.parse(await readFile(markerPath(h.root, h.server.executorId), 'utf8')) as Record<string, unknown>
  await writeFile(markerPath(h.root, h.server.executorId), JSON.stringify({ ...marker, teamFolder: 'Platform' }))
  await h.settle()
  assert.equal(await readFile(join(h.root, 'Platform', 'Projects', 'Old.md'), 'utf8'), 'o\n')
  assert.deepEqual(visible(await readdir(h.root)), ['Platform'])
  await runConsoleCommand(h.context, { command: 'configure', root: h.root, enabled: true, acceptExistingFiles: false })
  await h.settle()
  assert.equal((await loadFolderSyncConfig(h.stateDir)).teamFolder, 'Platform')
  assert.equal((await h.state()).teamLabel, 'Platform')
})
