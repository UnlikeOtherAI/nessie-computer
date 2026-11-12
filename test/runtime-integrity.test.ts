import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  collectExecutorRuntimeFacts,
  verifyExecutorRuntime,
  type ExecutorRuntimeEntryFacts,
  type ExecutorRuntimeFacts,
} from '../src/runtime-integrity.js'
import { WINDOWS_SYMLINK_SKIP } from './windows-prerequisites.js'

const NODE_BYTES = 'node-binary'
const BUNDLE_BYTES = 'executor-bundle'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const rootOwnedEntry = (overrides: Partial<ExecutorRuntimeEntryFacts> = {}): ExecutorRuntimeEntryFacts => ({
  isDirectory: false,
  isFile: true,
  isSymbolicLink: false,
  mode: 0o100644,
  uid: 0,
  ...overrides,
})

const manifestText = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  executorBundleSha256: sha256(BUNDLE_BYTES),
  format: 1,
  nodeExecutable: 'nessie-executor-runtime',
  nodeSha256: sha256(NODE_BYTES),
  nodeVersion: '22.22.2',
  ...overrides,
})

const packagedFacts = (overrides: Partial<ExecutorRuntimeFacts> = {}): ExecutorRuntimeFacts => ({
  digests: { 'nessie-executor.cjs': sha256(BUNDLE_BYTES), 'nessie-executor-runtime': sha256(NODE_BYTES) },
  directory: rootOwnedEntry({ isDirectory: true, isFile: false, mode: 0o40755 }),
  directoryRealPath: '/usr/lib/nessie-executor',
  files: {
    NODE_LICENSE: rootOwnedEntry(),
    'nessie-executor.cjs': rootOwnedEntry(),
    'manifest.json': rootOwnedEntry(),
    'nessie-executor-runtime': rootOwnedEntry({ mode: 0o100755 }),
  },
  manifestText: manifestText(),
  platform: 'linux',
  ...overrides,
})

const refusal = (facts: ExecutorRuntimeFacts): string => {
  const verdict = verifyExecutorRuntime(facts)
  assert.equal(verdict.ok, false)
  return verdict.ok ? '' : verdict.reason
}

test('a root-owned packaged runtime under /usr/lib passes verification', () => {
  assert.deepEqual(verifyExecutorRuntime(packagedFacts()), { ok: true })
})

test('a runtime whose files are owned by an ordinary user is refused on Linux', () => {
  const facts = packagedFacts()
  const reason = refusal({
    ...facts,
    files: { ...facts.files, 'nessie-executor-runtime': rootOwnedEntry({ mode: 0o100755, uid: 1000 }) },
  })
  assert.equal(reason, 'nessie-executor-runtime is not owned by root')
})

test('a group-writable runtime directory is refused even when root owns it', () => {
  const reason = refusal(packagedFacts({
    directory: rootOwnedEntry({ isDirectory: true, isFile: false, mode: 0o40775 }),
  }))
  assert.equal(reason, 'the packaged runtime directory is writable by users other than root')
})

test('a world-writable packaged file is refused', () => {
  const facts = packagedFacts()
  const reason = refusal({
    ...facts,
    files: { ...facts.files, 'nessie-executor.cjs': rootOwnedEntry({ mode: 0o100666 }) },
  })
  assert.equal(reason, 'nessie-executor.cjs is writable by users other than root')
})

test('a runtime outside a root-controlled location is refused', () => {
  const reason = refusal(packagedFacts({ directoryRealPath: '/home/person/nessie-executor' }))
  assert.equal(reason, 'the packaged runtime is not installed under /usr/lib or /usr/share')
})

test('a runtime under /usr/share is accepted', () => {
  assert.deepEqual(
    verifyExecutorRuntime(packagedFacts({ directoryRealPath: '/usr/share/nessie-executor' })),
    { ok: true },
  )
})

test('ownership is a Linux rule; other hosts keep their own trust root', () => {
  const facts = packagedFacts({ directoryRealPath: '/Applications/Nessie.app/Contents/Resources' })
  assert.deepEqual(
    verifyExecutorRuntime({
      ...facts,
      files: { ...facts.files, 'nessie-executor-runtime': rootOwnedEntry({ mode: 0o100755, uid: 501 }) },
      platform: 'darwin',
    }),
    { ok: true },
  )
})

test('a missing runtime directory, a missing file, and a symlinked file are each refused', () => {
  assert.equal(
    refusal({ ...packagedFacts(), directory: undefined }),
    'the packaged runtime directory is missing',
  )
  const facts = packagedFacts()
  const withoutLicense = { ...facts.files }
  delete withoutLicense.NODE_LICENSE
  assert.equal(
    refusal({ ...facts, files: withoutLicense }),
    'NODE_LICENSE is missing from the packaged runtime',
  )
  assert.equal(
    refusal({
      ...facts,
      files: { ...facts.files, 'nessie-executor-runtime': rootOwnedEntry({ isSymbolicLink: true, mode: 0o120777 }) },
    }),
    'nessie-executor-runtime is not an ordinary file',
  )
  assert.equal(
    refusal({ ...facts, directory: rootOwnedEntry({ isDirectory: true, isSymbolicLink: true }) }),
    'the packaged runtime is not an ordinary directory',
  )
})

test('an altered binary, an altered bundle, and an unsupported manifest are refused', () => {
  assert.equal(
    refusal(packagedFacts({ digests: { 'nessie-executor.cjs': sha256(BUNDLE_BYTES), 'nessie-executor-runtime': sha256('tampered') } })),
    'the packaged Node binary does not match the runtime manifest',
  )
  assert.equal(
    refusal(packagedFacts({ digests: { 'nessie-executor.cjs': sha256('tampered'), 'nessie-executor-runtime': sha256(NODE_BYTES) } })),
    'the packaged Nessie Computer bundle does not match the runtime manifest',
  )
  assert.equal(
    refusal(packagedFacts({ manifestText: manifestText({ format: 2 }) })),
    'the packaged runtime manifest declares an unsupported format',
  )
  assert.equal(
    refusal(packagedFacts({ manifestText: '{' })),
    'the packaged runtime manifest is malformed',
  )
  assert.equal(
    refusal(packagedFacts({ manifestText: manifestText({ nodeVersion: '' }) })),
    'the packaged runtime manifest names no Node version',
  )
  assert.equal(
    refusal(packagedFacts({ manifestText: undefined })),
    'the packaged runtime manifest is unreadable',
  )
})

test('the Node file name comes from the manifest, never from the verifying host', () => {
  // A Windows package inspected on any host must verify as itself, so the
  // POSIX-named binary is absent here and `nessie-executor-runtime.exe` carries the bytes.
  const posix = packagedFacts()
  const windowsFiles = { ...posix.files, 'nessie-executor-runtime.exe': rootOwnedEntry({ mode: 0o100755 }) }
  delete windowsFiles['nessie-executor-runtime']
  const windows = {
    ...posix,
    digests: { 'nessie-executor.cjs': sha256(BUNDLE_BYTES), 'nessie-executor-runtime.exe': sha256(NODE_BYTES) },
    files: windowsFiles,
    manifestText: manifestText({ nodeExecutable: 'nessie-executor-runtime.exe' }),
    platform: 'win32' as NodeJS.Platform,
  }
  assert.deepEqual(verifyExecutorRuntime(windows), { ok: true })

  // The same package read as if it were POSIX-shaped: the manifest, not the
  // host, decides, so a `nessie-executor-runtime.exe` package whose binary is missing is refused
  // by name rather than silently verifying some other file.
  assert.equal(
    refusal({ ...windows, files: posix.files }),
    'nessie-executor-runtime.exe is missing from the packaged runtime',
  )
})

test('a manifest that names no supported Node executable is refused', () => {
  // `node` is what a blanket kill matches, so a runtime may not be called that.
  for (const nodeExecutable of [
    undefined, '', 'node', 'node.exe', 'node.bin', '../nessie-executor-runtime', 'NESSIE-EXECUTOR-RUNTIME',
    'nessie-executor-runtime.exe ',
  ]) {
    assert.equal(
      refusal(packagedFacts({ manifestText: manifestText({ nodeExecutable }) })),
      'the packaged runtime manifest names no supported Node executable',
      `nodeExecutable ${JSON.stringify(nodeExecutable)} must be refused`,
    )
  }
})

test('a declared native helper is verified, and a half-declared one is refused', () => {
  const HELPER_BYTES = 'native-helper'
  const facts = packagedFacts()
  const withHelper = {
    ...facts,
    digests: { ...facts.digests, 'nessie-executor-native': sha256(HELPER_BYTES) },
    files: { ...facts.files, 'nessie-executor-native': rootOwnedEntry({ mode: 0o100755 }) },
    manifestText: manifestText({
      nativeHelper: 'nessie-executor-native',
      nativeHelperSha256: sha256(HELPER_BYTES),
    }),
  }
  assert.deepEqual(verifyExecutorRuntime(withHelper), { ok: true })

  assert.equal(
    refusal({ ...withHelper, digests: { ...withHelper.digests, 'nessie-executor-native': sha256('swapped') } }),
    'the packaged native helper does not match the runtime manifest',
  )
  assert.equal(
    refusal(packagedFacts({ manifestText: manifestText({ nativeHelper: 'nessie-executor-native' }) })),
    'the packaged runtime manifest describes its native helper incompletely',
  )
  assert.equal(
    refusal(packagedFacts({
      manifestText: manifestText({ nativeHelper: '../sh', nativeHelperSha256: sha256(HELPER_BYTES) }),
    })),
    'the packaged runtime manifest describes its native helper incompletely',
  )
  const missingHelper = { ...withHelper, files: facts.files }
  assert.equal(
    refusal(missingHelper),
    'nessie-executor-native is missing from the packaged runtime',
  )
})

test('a bundle executed from outside the verified runtime directory is refused', () => {
  assert.equal(
    refusal(packagedFacts({ runningBundleRealPath: '/tmp/nessie-executor.cjs' })),
    'the running Nessie Computer bundle is not the packaged one',
  )
  // Joined as the verifier joins it: facts are collected on the host that
  // checks them, so the running path has that host's separators.
  assert.deepEqual(
    verifyExecutorRuntime(packagedFacts({
      runningBundleRealPath: join('/usr/lib/nessie-executor', 'nessie-executor.cjs'),
    })),
    { ok: true },
  )
})

test('the filesystem adapter reports real digests, symlinks, and missing files', { skip: WINDOWS_SYMLINK_SKIP }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-runtime-'))
  try {
    await writeFile(join(directory, 'nessie-executor-runtime'), NODE_BYTES)
    await chmod(join(directory, 'nessie-executor-runtime'), 0o755)
    await writeFile(join(directory, 'nessie-executor.cjs'), BUNDLE_BYTES)
    await writeFile(join(directory, 'NODE_LICENSE'), 'license')
    await writeFile(join(directory, 'manifest.json'), manifestText())

    const facts = await collectExecutorRuntimeFacts(directory, {
      runningBundlePath: join(directory, 'nessie-executor.cjs'),
    })
    assert.equal(facts.digests['nessie-executor-runtime'], sha256(NODE_BYTES))
    assert.equal(facts.digests['nessie-executor.cjs'], sha256(BUNDLE_BYTES))
    assert.equal(facts.files['nessie-executor-runtime']?.isFile, true)
    // The location and ownership rules are Linux-only, and a temporary
    // directory is neither root-owned nor under /usr/lib.
    assert.deepEqual(verifyExecutorRuntime({ ...facts, platform: 'darwin' }), { ok: true })

    await unlink(join(directory, 'nessie-executor-runtime'))
    await symlink('/bin/sh', join(directory, 'nessie-executor-runtime'))
    const relinked = await collectExecutorRuntimeFacts(directory)
    assert.equal(relinked.files['nessie-executor-runtime']?.isSymbolicLink, true)
    assert.equal(
      refusal({ ...relinked, platform: 'darwin' }),
      'nessie-executor-runtime is not an ordinary file',
    )

    await unlink(join(directory, 'NODE_LICENSE'))
    const withoutLicense = await collectExecutorRuntimeFacts(directory)
    assert.equal(withoutLicense.files.NODE_LICENSE, undefined)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
