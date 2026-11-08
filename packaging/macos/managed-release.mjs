// One immutable personal-custody payload for signed CLI and app runtimes.
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const MAC_MANAGED_ROOT = '/Library/Application Support/Nessie Executor'
const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
const readonly = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error('Invalid release entry.')
    if (entry.isDirectory()) { await readonly(path); await chmod(path, 0o555) }
    else await chmod(path, (entry.name === 'nessie-executor-native' || entry.name === 'nessie-executor-runtime')
      ? 0o555 : 0o444)
  }
  await chmod(directory, 0o555)
}

/** Run after inside-out binary signing, before the enclosing app seal. */
export const finishMacManagedManifest = async (runtime) => {
  const resources = join(runtime.runtimeDirectory, 'resources')
  await mkdir(resources, { recursive: true })
  await writeFile(join(resources, 'manifest.json'), `${JSON.stringify({ format: 1, files: [] })}\n`)
  const manifest = { ...runtime.manifest, managedLaunchProtocol: 1, updateAdmissionProtocol: 1, personalInferenceGuardVersion: 2,
    executorBundleSha256: await digest(runtime.executorBundlePath), nodeSha256: await digest(runtime.nodePath),
    nativeHelper: 'nessie-executor-native', nativeHelperSha256: await digest(join(runtime.runtimeDirectory,
      'nessie-executor-native')), resourcesManifestSha256: await digest(join(resources, 'manifest.json')) }
  await writeFile(runtime.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  return manifest
}

/** Candidate assembly only. pkgbuild supplies root ownership at install time. */
export const stageMacManagedRelease = async (runtimeDirectory, payloadDirectory, scriptsDirectory) => {
  const manifestPath = join(runtimeDirectory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.managedLaunchProtocol !== 1 || manifest.personalInferenceGuardVersion !== 2
    || manifest.nodeExecutable !== 'nessie-executor-runtime' || manifest.nativeHelper !== 'nessie-executor-native') {
    throw new Error('The runtime has no managed personal custody contract.')
  }
  for (const [path, hash] of [['nessie-executor-runtime', manifest.nodeSha256],
    ['nessie-executor-native', manifest.nativeHelperSha256], ['nessie-executor.cjs', manifest.executorBundleSha256],
    ['resources/manifest.json', manifest.resourcesManifestSha256]]) {
    if (!/^[a-f0-9]{64}$/u.test(hash ?? '') || await digest(join(runtimeDirectory, path)) !== hash) {
      throw new Error('The runtime manifest does not match the candidate bytes.')
    }
  }
  const releaseDigest = await digest(manifestPath)
  const root = join(resolve(payloadDirectory), MAC_MANAGED_ROOT.slice(1))
  await mkdir(join(root, 'releases'), { recursive: true })
  const staging = join(root, 'releases', `${releaseDigest}.draft`)
  const released = join(root, 'releases', releaseDigest)
  await cp(runtimeDirectory, staging, { recursive: true, errorOnExist: true, force: false })
  await readonly(staging); await rename(staging, released)
  await symlink(`releases/${releaseDigest}`, join(root, 'current'), 'dir')
  const launcher = `#!/bin/sh\nset -eu\nunset NODE_OPTIONS NODE_PATH LD_PRELOAD DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH\n`
    + `exec '${MAC_MANAGED_ROOT}/releases/${releaseDigest}/nessie-executor-native' managed-runtime -- "$@"\n`
  const bin = join(resolve(payloadDirectory), 'usr/local/bin')
  await mkdir(bin, { recursive: true })
  // `nessie-computer` is the command's name; `nessie-executor` stays for what already calls it.
  for (const command of ['nessie-computer', 'nessie-executor']) await writeFile(join(bin, command), launcher, { mode: 0o755 })
  await mkdir(scriptsDirectory, { recursive: true })
  await writeFile(join(scriptsDirectory, 'postinstall'), `#!/bin/sh\nset -eu\n`
    + `exec '${MAC_MANAGED_ROOT}/releases/${releaseDigest}/nessie-executor-native' managed-custody-install\n`,
  { mode: 0o755 })
  return { releaseDigest, root: released }
}
