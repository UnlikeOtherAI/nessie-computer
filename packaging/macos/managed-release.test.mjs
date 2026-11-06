import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stageMacManagedRelease } from './managed-release.mjs'

test('the macOS package selects its complete immutable release through the current factory', {
  skip: process.platform === 'win32' ? 'macOS package symlinks and permission checks require POSIX' : false,
}, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'nessie-macos-managed-package-'))
  const writable = async directory => {
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await writable(path)
      else await chmod(path, 0o600)
    }
  }
  try {
    const runtime = join(scratch, 'runtime'), payload = join(scratch, 'payload'), scripts = join(scratch, 'scripts')
    await mkdir(join(runtime, 'resources'), { recursive: true })
    const files = { 'nessie-executor-runtime': 'candidate node', 'nessie-executor-native': 'candidate native',
      'nessie-executor.cjs': 'candidate entry', 'resources/manifest.json': '{"format":1,"files":[]}' }
    for (const [name, content] of Object.entries(files)) await writeFile(join(runtime, name), content)
    const hash = name => createHash('sha256').update(files[name]).digest('hex')
    await writeFile(join(runtime, 'manifest.json'), JSON.stringify({ format: 1, managedLaunchProtocol: 1,
      personalInferenceGuardVersion: 2, executorVersion: '1.0.0', executorSourceCommit: 'a'.repeat(40),
      nodeExecutable: 'nessie-executor-runtime', nativeHelper: 'nessie-executor-native',
      nodeSha256: hash('nessie-executor-runtime'), nativeHelperSha256: hash('nessie-executor-native'),
      executorBundleSha256: hash('nessie-executor.cjs'), resourcesManifestSha256: hash('resources/manifest.json') }))
    const candidate = await stageMacManagedRelease(runtime, payload, scripts)
    const root = join(payload, 'Library/Application Support/Nessie Executor')
    assert.equal(await readlink(join(root, 'current')), `releases/${candidate.releaseDigest}`)
    for (const name of ['nessie-executor-native', 'nessie-executor-runtime', 'nessie-executor.cjs']) {
      assert.equal(await realpath(join(root, 'current', name)), join(candidate.root, name))
    }
    assert.match(await readFile(join(payload, 'usr/local/bin/nessie-executor'), 'utf8'),
      new RegExp(`/releases/${candidate.releaseDigest}/nessie-executor-native`))
    assert.match(await readFile(join(scripts, 'postinstall'), 'utf8'), /managed-custody-install/)
  } finally { await writable(scratch); await rm(scratch, { recursive: true, force: true }) }
})
