// One root-owned payload for the DEB and RPM executor packages.
//
// The package is the Linux trust root. dpkg lays every file down root-owned
// (`--root-owner-group`), apt verifies the repository signature before that
// happens, and the CLI refuses to serve from a runtime that is not in exactly
// that state (executor/src/runtime-integrity.ts). Nothing here signs anything
// itself: a self-attesting hash is not a trust root.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { PERSONAL_INFERENCE_GUARD_VERSION } from '@nessie/executor-protocol'
import { prepareExecutorRuntime } from '../../scripts/prepare-runtime.mjs'

const run = promisify(execFile)

const packagingDirectory = dirname(fileURLToPath(import.meta.url))
const executorDirectory = resolve(packagingDirectory, '../..')


const INSTALL_PREFIX = 'usr/lib/nessie-executor'
const RESOURCES = 'resources'

// The Firecracker release is pinned by version AND by the SHA-256 its own
// published `<asset>.sha256.txt` states, verified here before a byte is
// unpacked — a pinned version alone trusts whoever can rewrite a release asset.
// Upgrading means changing both constants together, in one commit, after
// re-reading the upstream checksum file.
const FIRECRACKER_VERSION = 'v1.16.1'
const FIRECRACKER_ARCHIVE_SHA256 =
  '382a02a869e4d6d5cb14c40577f9545e8458021ea8b0b2d3fc10ec14d9c242e6'
const FIRECRACKER_MACHINE = 'x86_64'
const FIRECRACKER_URL = 'https://github.com/firecracker-microvm/firecracker/releases/download/'
  + `${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-${FIRECRACKER_MACHINE}.tgz`

// Only the firecracker binary is shipped. The jailer is deliberately absent:
// it is documented as running as root, and neither Linux supervisor is root
// (executor/src/firecracker/layout.ts). Shipping an executable this release
// cannot use would be a capability nobody audited.
const FIRECRACKER_BINARIES = ['firecracker']

// The guest kernel. Firecracker publishes the kernels its own CI boots, and
// this is the exact object that bucket serves — pinned by key AND by the
// SHA-256 of the bytes that key returned, verified before packaging. Upstream
// publishes no checksum file beside these objects (unlike the release archive
// above), so the digest recorded here was computed once from a fetch of that
// key and is what makes a later change to the object fail the build instead of
// shipping silently. Upgrading means changing both constants in one commit
// after re-reading the bucket.
//
// 6.1 rather than the 5.10 the same bucket offers: overlayfs `userxattr`
// (Linux 5.11+) is what lets the unprivileged guest report a directory its
// workload emptied. Both kernels carry CONFIG_BLK_DEV_INITRD, CONFIG_VIRTIO_BLK,
// CONFIG_EXT4_FS, CONFIG_OVERLAY_FS and CONFIG_VIRTIO_VSOCKETS; neither has
// virtio-fs, which is why the shares are block images at all.
const GUEST_KERNEL_CI_VERSION = 'v1.15'
const GUEST_KERNEL_RELEASE = '6.1.155'
const GUEST_KERNEL_SHA256 = 'e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2'
const GUEST_KERNEL_URL = 'https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/'
  + `${GUEST_KERNEL_CI_VERSION}/${FIRECRACKER_MACHINE}/vmlinux-${GUEST_KERNEL_RELEASE}`

/** The package publisher fixes the release path; user environment never selects executable code. */
export const linuxManagedLauncher = (releaseDigest) => {
  if (!/^[a-f0-9]{64}$/.test(releaseDigest)) throw new Error('Invalid immutable executor release digest.')
  const release = `/${INSTALL_PREFIX}/releases/${releaseDigest}`
  return [
    '#!/bin/sh',
    '# Runs one root-owned immutable release. Upgrade selects a new directory;',
    '# an existing process and its children keep their original release.',
    'set -eu',
    'unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH',
    'NESSIE_EXECUTOR_PACKAGED_CLI=1',
    'export NESSIE_EXECUTOR_PACKAGED_CLI',
    `exec ${release}/nessie-executor-native managed-runtime -- "$@"`,
    '',
  ].join('\n')
}

const makeReleaseReadonly = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await makeReleaseReadonly(path)
    else if (entry.isFile()) {
      const { mode } = await stat(path)
      await chmod(path, mode & 0o111 ? 0o555 : 0o444)
    } else throw new Error('An immutable executor release contains an unsupported file kind.')
  }
  await chmod(directory, 0o555)
}

const sha256File = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

const downloadPinned = async (url, destination, expected, label) => {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Downloading ${url} failed with HTTP ${response.status}.`)
  await writeFile(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o644 })
  const digest = await sha256File(destination)
  if (digest !== expected) {
    throw new Error(`The pinned ${label} hashed ${digest}, not ${expected}. Refusing to package it.`)
  }
}

/**
 * Downloads and verifies the pinned Firecracker release, then lays its two
 * binaries down under their unversioned names. dpkg makes them root-owned;
 * 0755 keeps them readable and executable by the daemon's own user while only
 * an administrator can replace them, which is what makes the packaged copy a
 * trust root rather than a self-attestation.
 */
const stageFirecracker = async (destination) => {
  await mkdir(destination, { mode: 0o755, recursive: true })
  const archive = join(destination, 'firecracker-release.tgz')
  await downloadPinned(FIRECRACKER_URL, archive, FIRECRACKER_ARCHIVE_SHA256, 'Firecracker release archive')
  const unpacked = join(destination, 'unpacked')
  await mkdir(unpacked, { mode: 0o755, recursive: true })
  await run('tar', ['--extract', '--gzip', '--file', archive, '--directory', unpacked])
  const releaseDirectory = join(unpacked, `release-${FIRECRACKER_VERSION}-${FIRECRACKER_MACHINE}`)
  for (const binary of FIRECRACKER_BINARIES) {
    await copyFile(
      join(releaseDirectory, `${binary}-${FIRECRACKER_VERSION}-${FIRECRACKER_MACHINE}`),
      join(destination, binary),
    )
    await chmod(join(destination, binary), 0o755)
  }
  await copyFile(join(releaseDirectory, 'LICENSE'), join(destination, 'LICENSE'))
  await chmod(join(destination, 'LICENSE'), 0o644)
  await rm(archive, { force: true })
  await rm(unpacked, { force: true, recursive: true })
}


/**
 * The guest payload: the Go init the initrd is built from, the portable initrd
 * builder that assembles it (the executor's `guestInitrdBuilderPath` on Linux
 * — it finds `init` as its own sibling, which is why the two ship together),
 * and the pinned guest kernel.
 */
const stageGuest = async (destination) => {
  await mkdir(destination, { mode: 0o755, recursive: true })
  const goEnvironment = { ...process.env, CGO_ENABLED: '0', GOARCH: 'amd64', GOOS: 'linux' }
  await run('go', ['build', '-trimpath', '-o', join(destination, 'init'), '.'], {
    cwd: join(executorDirectory, 'guest'),
    env: goEnvironment,
  })
  await chmod(join(destination, 'init'), 0o755)
  await run('go', ['build', '-trimpath', '-o', join(destination, 'build-initrd'), './cmd/build-initrd'], {
    cwd: join(executorDirectory, 'guest'),
    env: goEnvironment,
  })
  await chmod(join(destination, 'build-initrd'), 0o755)
  await downloadPinned(GUEST_KERNEL_URL, join(destination, 'vmlinux'), GUEST_KERNEL_SHA256, 'guest kernel')
  await chmod(join(destination, 'vmlinux'), 0o644)
}

/**
 * One sha256 per shipped sandbox resource, so an integrity check can say which
 * file changed rather than only that something did. `manifest.json` is excluded
 * from its own listing.
 */
const resourceManifest = async (directory) => {
  const files = []
  const walk = async (current) => {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile() && entry.name !== 'manifest.json') {
        files.push({ path: relative(directory, path), sha256: await sha256File(path) })
      }
    }
  }
  await walk(directory)
  return {
    files,
    firecrackerVersion: FIRECRACKER_VERSION,
    guestKernelVersion: GUEST_KERNEL_RELEASE,
    version: 1,
  }
}

// Entry selection is a build-time dependency. The production builders always
// use the ordinary CLI; an installed-test candidate binds its separate entry
// into its own immutable release rather than adding a runtime auth override.
export const stageLinuxPayload = async (stagingDirectory, version, {
  entryPoint = join(executorDirectory, 'src/index.ts'),
} = {}) => {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build Linux packages on a Linux x86_64 host.')
  const expectedStaging = resolve(executorDirectory, '../dist/executor-cli/linux-payload')
  if (resolve(stagingDirectory) !== expectedStaging) throw new Error('The Linux payload uses its dedicated build directory.')
  // Prior generated payloads have readonly release directories. Restore only
  // this exact disposable staging tree's directory permissions for replacement.
  const unstage = async (directory) => {
    const entry = await lstat(directory).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!entry) return
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe Linux payload staging directory.')
    await chmod(directory, 0o755)
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (child.isDirectory()) await unstage(join(directory, child.name))
    }
  }
  await unstage(expectedStaging)
  await rm(expectedStaging, { force: true, recursive: true })
  await mkdir(join(stagingDirectory, 'usr/bin'), { mode: 0o755, recursive: true })
  await mkdir(join(stagingDirectory, 'usr/lib/systemd/user'), { mode: 0o755, recursive: true })

  const releaseStaging = join(stagingDirectory, INSTALL_PREFIX, '.release-staging')
  const prepared = await prepareExecutorRuntime({
    entryPoint,
    executorVersion: version,
    nativeHelperPath: process.env.NESSIE_EXECUTOR_NATIVE_HELPER_PATH
      ?? join(executorDirectory, 'native/target/release/nessie-executor-native'),
    outputDirectory: releaseStaging,
  })
  await chmod(join(stagingDirectory, INSTALL_PREFIX), 0o755)

  // The sandbox artifacts a session resolves at start. `vmHelperPath` on Linux
  // is `resources/firecracker/firecracker`; `kernelPath` is
  // `resources/guest/vmlinux`; and `guestInitrdBuilderPath` is
  // `resources/guest/build-initrd`, which finds `resources/guest/init` beside
  // itself. All are root-owned under /usr/lib, which is exactly the provenance
  // `verifyPrivateGuestVmFile` admits as a packaged artifact.
  const resourcesDirectory = join(releaseStaging, RESOURCES)
  await mkdir(resourcesDirectory, { mode: 0o755, recursive: true })
  await stageFirecracker(join(resourcesDirectory, 'firecracker'))
  await stageGuest(join(resourcesDirectory, 'guest'))
  await writeFile(
    join(resourcesDirectory, 'manifest.json'),
    `${JSON.stringify(await resourceManifest(resourcesDirectory), null, 2)}\n`,
    { mode: 0o644 },
  )

  // The release name binds the manifest bytes, which bind every executable and
  // the resource manifest. No package upgrade rewrites a published release.
  const manifest = { ...prepared.manifest, managedLaunchProtocol: 1,
    personalInferenceGuardVersion: PERSONAL_INFERENCE_GUARD_VERSION,
    resourcesManifestSha256: await sha256File(join(resourcesDirectory, 'manifest.json')) }
  await writeFile(prepared.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 })
  const releaseDigest = await sha256File(prepared.manifestPath)
  const releases = join(stagingDirectory, INSTALL_PREFIX, 'releases')
  await mkdir(releases, { mode: 0o755 })
  const released = join(releases, releaseDigest)
  await rename(releaseStaging, released)
  await makeReleaseReadonly(released)
  await symlink(`releases/${releaseDigest}`, join(stagingDirectory, INSTALL_PREFIX, 'current'))
  await writeFile(join(stagingDirectory, 'usr/bin/nessie-executor'), linuxManagedLauncher(releaseDigest), { mode: 0o755 })
  await chmod(join(stagingDirectory, 'usr/bin/nessie-executor'), 0o755)
  // Root-owned durable custody lock is not package content: postinstall creates
  // it once, verifies it on upgrade, and package removal never deletes it.
  await writeFile(join(stagingDirectory, 'install-custody-barrier.sh'), [
    '#!/bin/sh', 'set -eu', 'unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH',
    `exec /${INSTALL_PREFIX}/releases/${releaseDigest}/nessie-executor-native managed-custody-install`, '',
  ].join('\n'), { mode: 0o755 })
  await mkdir(join(stagingDirectory, 'usr/share/licenses/nessie-executor'), { recursive: true })
  await copyFile(join(executorDirectory, 'LICENSE'), join(stagingDirectory, 'usr/share/licenses/nessie-executor/LICENSE'))
  await copyFile(
    join(packagingDirectory, 'nessie-executor@.service'),
    join(stagingDirectory, 'usr/lib/systemd/user/nessie-executor@.service'),
  )
  await chmod(join(stagingDirectory, 'usr/lib/systemd/user/nessie-executor@.service'), 0o644)
}
