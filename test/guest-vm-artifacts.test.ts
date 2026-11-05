import assert from 'node:assert/strict'
import { chmod, chown, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { verifyPrivateGuestVmFile } from '../src/guest-vm-artifacts.js'
import { readPinnedScriptDigests, verifyPinnedResource } from '../src/hyperv/scripts.js'
import { WINDOWS_GUEST_RESOURCES_SKIP } from './windows-prerequisites.js'

/**
 * The Linux trust root is not this account's ownership but dpkg's: apt
 * verifies the repository signature and dpkg lays every packaged file down
 * root-owned under /usr/lib, which only an administrator can produce. These
 * tests cover both admissible provenances and the refusals between them.
 *
 * The packaged branch needs a root-owned file under a real /usr prefix, which
 * only a root-capable process can create, so those cases run only there and
 * say so rather than silently passing.
 */
const asRoot = process.getuid?.() === 0

/**
 * The staging root is canonical because {@link verifyPrivateGuestVmFile} returns
 * the canonical path: on macOS both `/tmp` and `/var/folders` are symbolic links
 * into `/private`, so a raw `mkdtemp` path would never equal what it hands back.
 */
const stage = async (): Promise<string> => realpath(await mkdtemp(join(tmpdir(), 'nessie-artifacts-')))

test('an owner-private artifact is accepted, and a shared one is not', async (context) => {
  // Windows proves an artifact against the installed package manifest, never
  // by owner and mode, so this arm has nothing to stage there, packaged or not.
  if (process.platform === 'win32') {
    context.skip('Windows packaged artifacts use the installed manifest provenance test below')
    return
  }
  const root = await stage()
  try {
    const artifact = join(root, 'build-initrd')
    await writeFile(artifact, '#!/bin/sh\n', { mode: 0o700 })
    assert.equal(await verifyPrivateGuestVmFile(artifact, true), artifact)

    await chmod(artifact, 0o600)
    await assert.rejects(verifyPrivateGuestVmFile(artifact, true), /owner-private/)

    await chmod(artifact, 0o755)
    await assert.rejects(verifyPrivateGuestVmFile(artifact, true), /owner-private/)

    const link = join(root, 'link')
    await chmod(artifact, 0o700)
    await symlink(artifact, link)
    await assert.rejects(verifyPrivateGuestVmFile(link, true), /ordinary file/)

    await assert.rejects(verifyPrivateGuestVmFile('relative/path', false), /must be absolute/)

    // What comes back is the canonical path, never the one that was handed in:
    // a symbolic link in a parent directory is resolved away, so the caller
    // that stores or spawns the result cannot be pointed at an alias later.
    const directory = join(root, 'artifacts')
    await mkdir(directory, { mode: 0o700 })
    const nested = join(directory, 'build-initrd')
    await writeFile(nested, '#!/bin/sh\n', { mode: 0o700 })
    await symlink(directory, join(root, 'alias'))
    assert.equal(await verifyPrivateGuestVmFile(join(root, 'alias', 'build-initrd'), true), nested)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('a root-owned packaged artifact under /usr/lib is a trust root, a root-owned one elsewhere is not', async (context) => {
  if (!asRoot) {
    context.skip('creating a root-owned packaged artifact needs a root-capable process')
    return
  }
  const packaged = '/usr/lib/nessie-executor-test-artifacts'
  const elsewhere = await stage()
  try {
    await mkdir(packaged, { mode: 0o755, recursive: true })
    const kernel = join(packaged, 'vmlinux')
    await writeFile(kernel, 'kernel', { mode: 0o644 })
    await chown(kernel, 0, 0)
    // Root-owned, world-readable, not group- or world-writable, under the
    // packaged prefix: exactly what dpkg --root-owner-group produces.
    assert.equal(await verifyPrivateGuestVmFile(kernel, false), kernel)

    const builder = join(packaged, 'build-initrd')
    await writeFile(builder, '#!/bin/sh\n', { mode: 0o755 })
    await chown(builder, 0, 0)
    assert.equal(await verifyPrivateGuestVmFile(builder, true), builder)

    // A group-writable packaged file is not a trust root: anyone in that group
    // could replace the kernel a guest boots.
    await chmod(builder, 0o775)
    await assert.rejects(verifyPrivateGuestVmFile(builder, true), /owner-private/)
    await chmod(builder, 0o757)
    await assert.rejects(verifyPrivateGuestVmFile(builder, true), /owner-private/)

    // Root-owned outside the packaged prefixes proves nothing about who wrote
    // it, so it is refused rather than admitted by ownership alone.
    const strayPath = join(elsewhere, 'vmlinux')
    await writeFile(strayPath, 'kernel', { mode: 0o644 })
    await chown(strayPath, 0, 0)
    await assert.rejects(verifyPrivateGuestVmFile(strayPath, false), /owner-private/)

    // A symbolic link under the packaged prefix is still refused.
    const linked = join(packaged, 'linked')
    await symlink(strayPath, linked)
    await assert.rejects(verifyPrivateGuestVmFile(linked, false), /ordinary file/)
  } finally {
    await rm(packaged, { force: true, recursive: true })
    await rm(elsewhere, { force: true, recursive: true })
  }
})

test('a manifest-pinned resource accepts only the installed bytes and never escapes its resource root', async () => {
  const root = await stage()
  try {
    const resources = join(root, 'resources')
    const guest = join(resources, 'guest')
    await mkdir(guest, { recursive: true })
    const artifact = join(guest, 'build-initrd.exe')
    await writeFile(artifact, 'trusted artifact')
    const digest = '29dcd450ef0324ad1a5a65092c7c36a05d064b549c08d32b5583675e78cea936'
    await writeFile(join(resources, 'manifest.json'), JSON.stringify({
      files: [{ path: 'guest\\build-initrd.exe', sha256: digest }],
    }))
    const digests = await readPinnedScriptDigests(resources)
    assert.equal(await verifyPinnedResource({ path: artifact, resourcesDirectory: resources, digests }), artifact)

    await writeFile(artifact, 'altered artifact')
    await assert.rejects(
      verifyPinnedResource({ path: artifact, resourcesDirectory: resources, digests }),
      /does not match/,
    )
    await assert.rejects(
      verifyPinnedResource({ path: join(root, 'outside.exe'), resourcesDirectory: resources, digests }),
      /not a packaged resource/,
    )
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('an installed Windows package validates its real VM artifact and rejects an untrusted copy', async (context) => {
  if (process.platform !== 'win32') {
    context.skip('requires the installed Windows executor runtime')
    return
  }
  if (WINDOWS_GUEST_RESOURCES_SKIP) {
    context.skip(WINDOWS_GUEST_RESOURCES_SKIP)
    return
  }
  const installedArtifact = join(dirname(process.execPath), 'resources', 'guest', 'build-initrd.exe')
  assert.equal(await verifyPrivateGuestVmFile(installedArtifact, true), installedArtifact)

  const root = await stage()
  try {
    const copy = join(root, 'build-initrd.exe')
    await writeFile(copy, 'untrusted copy')
    await assert.rejects(verifyPrivateGuestVmFile(copy, true), /not.*package|not pinned/i)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
