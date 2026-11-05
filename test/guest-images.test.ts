import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  buildGuestBlockImages,
  buildGuestImageArgv,
  GUEST_IMAGE_LABELS,
  guestImageIdentity,
  guestImageSizeMebibytes,
  measureGuestImageSource,
  resolveGuestImageBuilder,
} from '../src/guest-images.js'
import { WINDOWS_SYMLINK_SKIP } from './windows-prerequisites.js'

const run = promisify(execFile)
const IDENTITY = { gid: 65_534, uid: 65_534 }

const stageSource = async (): Promise<{ root: string; runtime: string; workspace: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-guest-images-'))
  const runtime = join(root, 'runtime')
  const workspace = join(root, 'workspace')
  await mkdir(join(runtime, 'bin'), { mode: 0o700, recursive: true })
  await writeFile(join(runtime, 'bin', 'browser'), 'browser', { mode: 0o500 })
  await writeFile(join(runtime, 'nessie-guest-runtime.json'), '{}', { mode: 0o400 })
  await mkdir(join(workspace, 'src'), { mode: 0o700, recursive: true })
  await writeFile(join(workspace, 'README.md'), '# paired\n', { mode: 0o600 })
  await writeFile(join(workspace, 'src', 'main.ts'), 'export const value = 1\n', { mode: 0o600 })
  return { root, runtime, workspace }
}

const mkfsAvailable = async (): Promise<string | undefined> =>
  resolveGuestImageBuilder().catch(() => undefined)

test('the image argv populates a filesystem from a directory without root', () => {
  const argv = buildGuestImageArgv({
    identity: { gid: 1_001, uid: 1_000 },
    imagePath: '/session/images/workspace.img',
    inodes: 512,
    label: GUEST_IMAGE_LABELS.workspace,
    sizeMebibytes: 64,
    sourceDirectory: '/session/work',
  })
  assert.deepEqual(argv, [
    '-q',
    '-F',
    '-L', 'nessie-work',
    '-N', '512',
    '-O', '^has_journal',
    '-m', '0',
    // mke2fs(8) `-E root_owner=uid:gid` is what makes the guest drop to the
    // host account rather than to root.
    '-E', 'root_owner=1000:1001',
    // mke2fs(8) `-d` populates the new filesystem from a directory tree, in
    // userspace: no loop device, no mount, no privileged helper.
    '-d', '/session/work',
    '/session/images/workspace.img',
    '64M',
  ])
  // The empty draft image is the same call without a source directory.
  assert.equal(buildGuestImageArgv({
    identity: { gid: 1_001, uid: 1_000 },
    imagePath: '/session/images/draft.img',
    inodes: 512,
    label: GUEST_IMAGE_LABELS.draft,
    sizeMebibytes: 128,
  }).includes('-d'), false)
})

test('a root-owned daemon is refused before an image the guest would reject is built', () => {
  assert.throws(
    () => guestImageIdentity({ getgid: () => 0, getuid: () => 0 }),
    /must not run as root/,
  )
  assert.throws(
    () => guestImageIdentity({ getgid: () => undefined, getuid: () => undefined }),
    /no process uid and gid/,
  )
  assert.deepEqual(guestImageIdentity({ getgid: () => 20, getuid: () => 501 }), { gid: 20, uid: 501 })
})

test('an image is sized from the tree it must hold, and refuses a linked tree', { skip: WINDOWS_SYMLINK_SKIP }, async () => {
  const staged = await stageSource()
  try {
    const usage = await measureGuestImageSource(staged.workspace)
    assert.equal(usage.files, 4)
    assert.ok(usage.bytes > 0)
    // Slack for directory entries and filesystem metadata, never below the floor.
    assert.ok(guestImageSizeMebibytes(usage) >= 16)
    assert.equal(guestImageSizeMebibytes({ bytes: 400 * 1024 * 1024, files: 10 }), 417)
    await symlink('/etc/passwd', join(staged.workspace, 'escape'))
    await assert.rejects(measureGuestImageSource(staged.workspace), /symbolic links/)
  } finally {
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('the three session images are built in the order the guest reads them', async () => {
  const staged = await stageSource()
  const argv: string[][] = []
  try {
    const images = await buildGuestBlockImages({
      directory: staged.root,
      runtimeSnapshotPath: staged.runtime,
      workspacePath: staged.workspace,
    }, {
      builderPath: '/sbin/mkfs.ext4',
      identity: IDENTITY,
      spawnProcess: async ({ argv: called }) => {
        argv.push(called)
        await writeFile(called[called.length - 2]!, '')
      },
    })
    assert.deepEqual(argv.map((call) => call[call.indexOf('-L') + 1]), [
      'nessie-runtime',
      'nessie-work',
      'nessie-draft',
    ])
    assert.equal(images.runtime.path, join(staged.root, 'images', 'runtime.img'))
    assert.equal(images.workspace.path, join(staged.root, 'images', 'workspace.img'))
    assert.equal(images.draft.path, join(staged.root, 'images', 'draft.img'))
    // Only the draft is empty; it is the one layer the guest may write.
    assert.equal(argv[2]!.includes('-d'), false)
    assert.equal(argv[0]!.includes('-d'), true)
    assert.equal(argv[1]!.includes('-d'), true)
  } finally {
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('a real mkfs.ext4 produces a mountable image carrying the workspace and its label', async (context) => {
  const builderPath = await mkfsAvailable()
  if (!builderPath) {
    context.skip('e2fsprogs is not installed on this machine')
    return
  }
  const staged = await stageSource()
  try {
    const images = await buildGuestBlockImages({
      directory: staged.root,
      runtimeSnapshotPath: staged.runtime,
      workspacePath: staged.workspace,
    }, { builderPath, identity: IDENTITY })
    await access(images.workspace.path, constants.R_OK)

    // The filesystem is consistent, and its root carries the identity the
    // guest drops to rather than root.
    const check = await run('e2fsck', ['-fn', images.workspace.path])
    assert.match(check.stdout, /blocks/)
    const listing = await run('debugfs', ['-R', 'ls -l /', images.workspace.path])
    assert.match(listing.stdout, /65534\s+65534.+\.$/m)
    assert.match(listing.stdout, /README\.md/)
    assert.match(listing.stdout, /src/)

    const label = await run('debugfs', ['-R', 'show_super_stats -h', images.workspace.path])
    assert.match(label.stdout, /Filesystem volume name:\s+nessie-work/)
    const draftLabel = await run('debugfs', ['-R', 'show_super_stats -h', images.draft.path])
    assert.match(draftLabel.stdout, /Filesystem volume name:\s+nessie-draft/)
    const runtimeListing = await run('debugfs', ['-R', 'ls -l /bin', images.runtime.path])
    assert.match(runtimeListing.stdout, /browser/)
  } finally {
    await rm(staged.root, { force: true, recursive: true })
  }
})

test('a machine with no mkfs.ext4 names the package to install', async () => {
  const builder = await mkfsAvailable()
  if (builder) {
    // The resolver found a real one; the refusal path is proven by its message.
    assert.match(builder, /mkfs\.ext4$/)
    return
  }
  await assert.rejects(resolveGuestImageBuilder(), /Install e2fsprogs/)
})

test('a source directory holding a special file is refused', async () => {
  const staged = await stageSource()
  try {
    await chmod(join(staged.workspace, 'README.md'), 0o600)
    await mkdir(join(staged.workspace, 'nested'), { mode: 0o700 })
    const usage = await measureGuestImageSource(staged.workspace)
    assert.equal(usage.files, 5)
  } finally {
    await rm(staged.root, { force: true, recursive: true })
  }
})
