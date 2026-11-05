import assert from 'node:assert/strict'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'

import {
  FolderSyncConsoleCommandResultSchema,
  FolderSyncConsoleStateSchema,
  FolderSyncVerifyReportSchema,
} from '@nessie/executor-protocol'

import { parseCommand } from '../src/cli-arguments.js'
import { startFolderSyncLoop } from '../src/folder-sync/engine-loop.js'
import { parseSyncArguments, runSyncCli, type SyncCliCommand } from '../src/folder-sync/sync-cli.js'
import type { ExecutorLocalState } from '../src/state-store.js'
import { createSyncHarness, testSecurity, type SyncHarness } from './support/folder-sync-harness.js'

const usage = (): never => { throw new Error('usage') }

const run = async (h: SyncHarness, args: string[], stdin?: unknown) => {
  let out = ''
  const stdout = new Writable({ write(chunk, _encoding, done) { out += String(chunk); done() } })
  const command = parseSyncArguments(['sync', '--state-dir', h.stateDir, ...args], usage)
  const code = await runSyncCli(command, {
    stdin: Readable.from(stdin === undefined ? [] : [JSON.stringify(stdin)]),
    stdout,
    stateDir: h.stateDir,
    state: { executorId: h.server.executorId, workspaceFolders: [] } as unknown as ExecutorLocalState,
    transport: () => h.transport,
    home: h.home,
    security: testSecurity,
  })
  return { code, out, json: () => JSON.parse(out) as unknown }
}

const consoleResult = (value: unknown) => FolderSyncConsoleCommandResultSchema.parse(value)

test('sync arguments: --executor or --state-dir on every verb, one verb, stdin without a verb', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  assert.deepEqual(parseSyncArguments(['sync', '--executor', id, 'status', '--json'], usage), {
    kind: 'sync', verb: 'status', json: true, inputStdin: false, acceptExistingFiles: false, executorId: id,
  } satisfies SyncCliCommand)
  assert.equal(parseSyncArguments(['sync', '--state-dir', '/s', 'trash', '--json'], usage).verb, 'trash')
  assert.equal(parseSyncArguments(['sync', '--state-dir', '/s', '--input-stdin', '--json'], usage).inputStdin, true)
  assert.equal(parseSyncArguments(['sync', '--executor', id], usage).verb, 'status')
  const resolve = parseSyncArguments(['sync', '--executor', id, 'resolve', '--conflict', id, '--resolution', 'keep_mine'], usage)
  assert.equal(resolve.resolution, 'keep_mine')
  assert.throws(() => parseSyncArguments(['sync', 'status'], usage), /usage/u)
  assert.throws(() => parseSyncArguments(['sync', '--executor', id, '--input-stdin', 'on'], usage), /usage/u)
  assert.throws(() => parseSyncArguments(['sync', '--executor', id, 'on', 'off'], usage), /usage/u)
  assert.throws(() => parseSyncArguments(['sync', '--executor', id, 'resolve', '--resolution', 'later'], usage), /usage/u)
  assert.equal(parseCommand(['sync', '--state-dir', '/s', 'status']).kind, 'sync')
})

test('status --json through --state-dir is a FolderSyncConsoleState, before and after sync starts', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const before = await run(h, ['status', '--json'])
  assert.equal(before.code, 0)
  const off = FolderSyncConsoleStateSchema.parse(before.json())
  assert.equal(off.state, 'off')
  assert.equal(off.defaultRoot, h.root)
  h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Hello', content: 'hi\n' })
  await h.enable()
  await h.settle()
  const on = FolderSyncConsoleStateSchema.parse((await run(h, ['status', '--json'])).json())
  assert.equal(on.state, 'up_to_date')
  assert.equal(on.root, h.root)
})

test('stdin commands answer a result with exit 0 — applied, confirm and refused alike', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  // The switch with no folder chosen sends the default root: it is created, never refused.
  const applied = await run(h, ['--input-stdin', '--json'], { command: 'configure', root: h.root, enabled: true, acceptExistingFiles: false })
  assert.equal(applied.code, 0)
  assert.equal(consoleResult(applied.json()).outcome, 'applied')
  assert.ok((await stat(h.root)).isDirectory())

  const other = join(h.home, 'Elsewhere')
  await mkdir(join(other, 'notes'), { recursive: true })
  await writeFile(join(other, 'a.txt'), 'a')
  await writeFile(join(other, 'notes', 'b.txt'), 'b')
  const confirm = await run(h, ['--input-stdin', '--json'], { command: 'configure', root: other, enabled: true, acceptExistingFiles: false })
  assert.equal(confirm.code, 0)
  assert.deepEqual(consoleResult(confirm.json()), { outcome: 'confirm_existing_files', fileCount: 2 })

  const agentsFolder = join(h.home, 'Nessie')
  await mkdir(agentsFolder)
  const refused = await run(h, ['--input-stdin', '--json'], { command: 'configure', root: agentsFolder, enabled: true, acceptExistingFiles: false })
  assert.equal(refused.code, 0)
  assert.deepEqual(consoleResult(refused.json()), { outcome: 'refused', reason: 'root_overlaps_workspace_folder' })
  const nested = await run(h, ['--input-stdin', '--json'], { command: 'configure', root: join(agentsFolder, 'Docs'), enabled: true, acceptExistingFiles: false })
  assert.equal(consoleResult(nested.json()).outcome, 'refused')

  const pause = await run(h, ['--input-stdin', '--json'], { command: 'pause', paused: true })
  const paused = consoleResult(pause.json())
  assert.ok(paused.outcome === 'applied' && paused.state.paused && paused.state.state === 'paused')
  const held = await run(h, ['--input-stdin', '--json'], {
    command: 'held_deletes', batchId: '22222222-2222-4222-8222-222222222222', decision: 'confirm',
  })
  assert.deepEqual(consoleResult(held.json()), { outcome: 'refused', reason: 'held_deletes_changed' })
  const resolve = await run(h, ['--input-stdin', '--json'], {
    command: 'resolve', clientConflictId: '33333333-3333-4333-8333-333333333333', resolution: 'keep_mine',
  })
  assert.deepEqual(consoleResult(resolve.json()), { outcome: 'refused', reason: 'conflict_not_found' })
  await assert.rejects(run(h, ['--input-stdin', '--json'], { command: 'configure', root: h.root }), 'a malformed command is a real failure')
})

test('a typed verb that is refused exits 2', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const file = join(h.home, 'not-a-folder')
  await writeFile(file, 'x')
  const result = await run(h, ['on', '--root', file])
  assert.equal(result.code, 2)
  assert.match(result.out, /root_not_a_directory/u)
})

test('the running engine picks up a configuration change with no restart', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Live', content: 'on\n' })
  const loop = startFolderSyncLoop(h.engine, { watch: false })
  t.after(() => loop.stop())
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(await h.readOrNull('Projects/Live.md'), null)
  await run(h, ['on'])
  const deadline = Date.now() + 15_000
  while (await h.readOrNull('Projects/Live.md') === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(await h.read('Projects/Live.md'), 'on\n')
  assert.equal(loop.summary()?.requested, true)
})

test('teamLabel is the team folder on disk and conflict paths are relative to it', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  h.server.teamLabel = 'Acme: R&D'
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'spec.bin', content: 'base' })
  await h.enable()
  await h.settle()
  const state = FolderSyncConsoleStateSchema.parse((await run(h, ['status', '--json'])).json())
  assert.equal(state.teamLabel, 'Acme_ R&D')
  assert.deepEqual(await readdir(h.root).then((names) => names.filter((name) => !name.startsWith('.'))), ['Acme_ R&D'])
  const teamDir = join(h.root, state.teamLabel!)
  h.server.actor.edit(doc.id, 'theirs')
  await writeFile(join(teamDir, 'Projects', 'spec.bin'), 'mine')
  for (let pass = 0; pass < 8; pass += 1) {
    h.advance(3_000)
    await h.engine.runPass({ scope: null })
  }
  const conflicted = FolderSyncConsoleStateSchema.parse((await run(h, ['status', '--json'])).json())
  assert.equal(conflicted.conflicts.length, 1)
  const row = conflicted.conflicts[0]!
  assert.ok((await stat(join(teamDir, ...row.relPath.split('/')))).isFile())
  assert.ok((await stat(join(teamDir, ...row.copy!.relPath.split('/')))).isFile())
})

test('trash --json lists what sync trashed, and restore_trash puts an entry back', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  const doc = h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'Gone', content: 'keep me\n' })
  await h.enable()
  await h.settle()
  h.server.actor.archive(doc.id)
  await h.settle()
  const listed = (await run(h, ['trash', '--json'])).json() as { entries: Array<{ entryId: string; relPath: string; deletedAt: string }> }
  assert.equal(listed.entries.length, 1)
  assert.equal(listed.entries[0]!.relPath, 'Projects/Gone.md')
  const restored = await run(h, ['--input-stdin', '--json'], { command: 'restore_trash', entryId: listed.entries[0]!.entryId })
  assert.equal(restored.code, 0)
  assert.equal(consoleResult(restored.json()).outcome, 'applied')
  assert.equal(await h.read('Projects/Gone.md'), 'keep me\n')
  assert.deepEqual(((await run(h, ['trash', '--json'])).json() as { entries: unknown[] }).entries, [])
  const again = await run(h, ['--input-stdin', '--json'], { command: 'restore_trash', entryId: listed.entries[0]!.entryId })
  assert.deepEqual(again.json(), { outcome: 'refused', reason: 'trash_entry_not_found' })
  await h.settle()
  const back = h.server.find('Projects/Gone.md') ?? h.server.find('Projects/Gone')
  assert.equal(h.server.text(back), 'keep me\n', 'the restored file goes back to Nessie as a page')
})

test('verify compares the owner\'s snapshot with the folder by hash, and exits 3 on a mismatch', async (t) => {
  const h = await createSyncHarness()
  t.after(h.cleanup)
  h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'document', title: 'One', content: '1\n' })
  h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'two.txt', content: '2' })
  h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'empty.txt' })
  await h.enable()
  await h.settle()
  const good = await run(h, ['verify', '--json'])
  assert.equal(good.code, 0)
  const report = FolderSyncVerifyReportSchema.parse(good.json())
  assert.equal(report.expected, 2)
  assert.equal(report.present, 2)
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.mismatched, [])
  assert.deepEqual(report.skipped.map((item) => item.reason), ['no_content_yet'])
  await h.write('Projects/two.txt', 'changed')
  await h.write('Projects/stray.txt', 'stray')
  const bad = await run(h, ['verify', '--json'])
  assert.equal(bad.code, 3)
  const failed = FolderSyncVerifyReportSchema.parse(bad.json())
  assert.deepEqual(failed.mismatched.map((item) => item.relPath), ['Projects/two.txt'])
  assert.deepEqual(failed.extra, ['Projects/stray.txt'])
})
