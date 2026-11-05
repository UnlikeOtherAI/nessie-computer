import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FolderSyncFileBusyError,
  FolderSyncLocalDriftError,
  FolderSyncPathRefusedError,
  confinedPath,
  hashFile,
  installFile,
  lstatOrNull,
  moveItem,
  openForUpload,
  recoverInstall,
  sha256,
  sweepTrash,
  trashItem,
} from '../src/folder-sync/local-fs.js'
import { LocalScanner } from '../src/folder-sync/local-scan.js'

const windows = process.platform === 'win32'
const windowsOnly = (name: string, reason: string, body: () => Promise<void>) =>
  windows ? test(name, body) : test.skip(`${name} (${reason})`, body)

const tempRoot = async (t: test.TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-fs-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  const root = join(dir, 'team')
  const trash = join(dir, 'trash')
  const parts = join(dir, 'pending')
  for (const each of [root, trash, parts]) await mkdir(each)
  return { dir, root, trash, parts }
}

test('confinement refuses climbing, absolute, empty and NUL segments', () => {
  const root = join(tmpdir(), 'team')
  assert.equal(confinedPath(root, 'Space/a.md'), join(root, 'Space', 'a.md'))
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a//b', './a', 'a/\0b', 'a\\b', 'C:/x', 'c:/x']) {
    assert.throws(() => confinedPath(root, bad), FolderSyncPathRefusedError, bad)
  }
  if (windows) {
    for (const bad of ['C:x', 'a:stream', 'Space/a:stream']) {
      assert.throws(() => confinedPath(root, bad), FolderSyncPathRefusedError, bad)
    }
  } else {
    assert.equal(confinedPath(root, 'Space/a:stream'), join(root, 'Space', 'a:stream'))
  }
})

test('an atomic replace installs over exactly the bytes the plan saw, and never over others', async (t) => {
  const { root, parts } = await tempRoot(t)
  const target = join(root, 'Space', 'doc.md')
  const part = join(parts, 'p1.part')
  await writeFile(part, 'new')
  await installFile(root, part, target, { expectHash: null, readOnly: false })
  assert.equal(await readFile(target, 'utf8'), 'new')
  assert.equal(await lstatOrNull(part), null, 'the part was moved, not copied')

  await writeFile(part, 'newer')
  let journaled = false
  await installFile(root, part, target, { expectHash: sha256(Buffer.from('new')), readOnly: false, beforeRename: async () => { journaled = true } })
  assert.ok(journaled)
  assert.equal(await readFile(target, 'utf8'), 'newer')

  await writeFile(part, 'stale')
  await assert.rejects(installFile(root, part, target, { expectHash: sha256(Buffer.from('new')), readOnly: false }), FolderSyncLocalDriftError)
  assert.equal(await readFile(target, 'utf8'), 'newer', 'the person\'s bytes stay')
  assert.equal(await readFile(part, 'utf8'), 'stale', 'the part stays for the replan')
  assert.deepEqual((await readdir(join(root, 'Space'))).sort(), ['doc.md'], 'no staging litter is left')
})

for (const existed of [false, true]) {
  test(`a save during the install journal flush survives (${existed ? 'replacement' : 'new file'})`, async (t) => {
    const { root, parts } = await tempRoot(t)
    const target = join(root, 'doc.md')
    const source = join(parts, 'download.part')
    if (existed) await writeFile(target, 'previous bytes')
    await writeFile(source, 'downloaded bytes')
    await assert.rejects(installFile(root, source, target, {
      expectHash: existed ? sha256(Buffer.from('previous bytes')) : null,
      readOnly: false,
      beforeRename: () => writeFile(target, 'saved while the journal was flushing'),
    }), FolderSyncLocalDriftError)
    assert.equal(await readFile(target, 'utf8'), 'saved while the journal was flushing')
    assert.equal(await readFile(source, 'utf8'), 'downloaded bytes', 'the download remains available for replanning')
    assert.deepEqual(await readdir(root), ['doc.md'])
  })
}

test('a crash mid-install is recovered: a file renamed aside comes back', async (t) => {
  const { root } = await tempRoot(t)
  const target = join(root, 'doc.md')
  await writeFile(join(root, '.nessie-sync-aside-a7'), 'person\'s bytes')
  await writeFile(join(root, '.nessie-sync-part-a7'), 'half')
  await recoverInstall(target, 'a7')
  assert.equal(await readFile(target, 'utf8'), 'person\'s bytes')
  assert.deepEqual(await readdir(root), ['doc.md'])
})

test('the trash keeps a deleted item under its date and path, and the sweep drops days past retention', async (t) => {
  const { root, trash } = await tempRoot(t)
  await mkdir(join(root, 'Space'))
  await writeFile(join(root, 'Space', 'a.txt'), 'a')
  const found = await lstatOrNull(join(root, 'Space', 'a.txt'))
  const now = Date.parse('2026-11-03T12:00:00Z')
  const kept = await trashItem(trash, root, 'Space/a.txt', { fileId: found!.fileId, contentHash: sha256(Buffer.from('a')) }, now)
  assert.equal(kept, join(trash, '2026-11-03', 'Space', 'a.txt'))
  assert.equal(await lstatOrNull(join(root, 'Space', 'a.txt')), null)
  await writeFile(join(root, 'Space', 'a.txt'), 'b')
  const second = await trashItem(trash, root, 'Space/a.txt', null === null ? { fileId: null, contentHash: null } : null, now)
  assert.equal(second, join(trash, '2026-11-03', 'Space', 'a.txt (2)'))
  await assert.rejects(trashItem(trash, root, 'Space/missing.txt', { fileId: null, contentHash: null }, now), FolderSyncLocalDriftError)
  await mkdir(join(trash, '2026-09-01'))
  await sweepTrash(trash, now)
  assert.deepEqual((await readdir(trash)).sort(), ['2026-11-03'])
})

test('links are reported, never followed, and never a parent of a write', async (t) => {
  const { dir, root, parts } = await tempRoot(t)
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'secret')
  try {
    await symlink(outside, join(root, 'linked'), windows ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`this account cannot create links: ${(error as Error).message}`)
    return
  }
  const scan = await new LocalScanner().scan(root, [], null, Date.now())
  assert.deepEqual(scan.links, ['linked'])
  assert.ok(!scan.items.some((item) => item.relPath.startsWith('linked/')), 'the walk did not follow the link')
  const part = join(parts, 'p.part')
  await writeFile(part, 'x')
  await assert.rejects(installFile(root, part, join(root, 'linked', 'new.txt'), { expectHash: null, readOnly: false }), FolderSyncPathRefusedError)
  assert.equal(await lstatOrNull(join(outside, 'new.txt')), null)
})

test('a move refuses a taken target but allows a case-only rename', async (t) => {
  const { root } = await tempRoot(t)
  await writeFile(join(root, 'a.txt'), 'a')
  await writeFile(join(root, 'b.txt'), 'b')
  await assert.rejects(moveItem(root, join(root, 'a.txt'), join(root, 'b.txt'), null === null ? { fileId: null, contentHash: null } : null),
    FolderSyncLocalDriftError)
  await moveItem(root, join(root, 'a.txt'), join(root, 'A.txt'), { fileId: null, contentHash: null })
  assert.ok((await readdir(root)).includes('A.txt'))
})

test('the scanner hashes a file only once it has been still for two seconds', async (t) => {
  const { root } = await tempRoot(t)
  await writeFile(join(root, 'new.txt'), 'hello')
  const scanner = new LocalScanner()
  const first = await scanner.scan(root, [], null, 1_000_000)
  assert.equal(first.items[0]!.contentHash, null)
  const later = await scanner.scan(root, [], null, 1_003_000)
  assert.equal(later.items[0]!.contentHash, await hashFile(join(root, 'new.txt')))
})

windowsOnly('a file held open for writing by another program is busy, never read torn', 'Windows share modes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-fs-'))
  const path = join(dir, 'held.docx')
  await writeFile(path, 'locked')
  const exclusive = 0x1000_0000 // libuv's UV_FS_O_EXLOCK: no other open while held
  const held = await open(path, constants.O_RDWR | exclusive)
  try {
    await assert.rejects(openForUpload(path), FolderSyncFileBusyError)
    await assert.rejects(hashFile(path), FolderSyncFileBusyError)
  } finally {
    await held.close()
  }
  const handle = await openForUpload(path)
  await handle.close()
  await rm(dir, { recursive: true, force: true })
})

windowsOnly('paths past MAX_PATH and reserved device names work through \\\\?\\ paths', 'Windows path limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-fs-'))
  const root = join(dir, 'team')
  await mkdir(root)
  const deep = Array.from({ length: 6 }, (_, n) => `${'segment'.repeat(6)}-${n}`).join('/')
  const relPath = `${deep}/CON.md`
  const part = join(dir, 'p.part')
  await writeFile(part, 'deep')
  const target = confinedPath(root, relPath)
  assert.ok(target.length > 260)
  await installFile(root, part, target, { expectHash: null, readOnly: false })
  assert.equal(await hashFile(target), sha256(Buffer.from('deep')))
  const scan = await new LocalScanner().scan(root, [], null, Date.now())
  assert.ok(scan.items.some((item) => item.relPath === relPath))
  await rm(`\\\\?\\${dir}`, { recursive: true, force: true })
})

windowsOnly('a read-only mirror carries the read-only attribute and is still replaced by the next download', 'Windows file attributes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-fs-'))
  const root = join(dir, 'team')
  await mkdir(root)
  const part = join(dir, 'p.part')
  const target = join(root, 'sheet.xlsx')
  await writeFile(part, 'v1')
  await installFile(root, part, target, { expectHash: null, readOnly: true })
  assert.equal((await stat(target)).mode & 0o200, 0, 'read-only')
  await assert.rejects(writeFile(target, 'edit'))
  await writeFile(part, 'v2')
  await installFile(root, part, target, { expectHash: sha256(Buffer.from('v1')), readOnly: true })
  assert.equal(await readFile(target, 'utf8'), 'v2')
  await rm(dir, { recursive: true, force: true })
})
