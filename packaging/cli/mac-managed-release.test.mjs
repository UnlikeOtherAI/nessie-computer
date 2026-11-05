import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishMacManagedManifest, stageMacManagedRelease, MAC_MANAGED_ROOT } from '../macos/managed-release.mjs'

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-mac-candidate-'))
  const directory = join(root, 'runtime'); await mkdir(directory)
  for (const name of ['nessie-executor-native', 'nessie-executor-runtime', 'nessie-executor.cjs', 'NODE_LICENSE']) {
    await writeFile(join(directory, name), `candidate ${name}`)
  }
  const runtime = { runtimeDirectory: directory, manifestPath: join(directory, 'manifest.json'),
    nodePath: join(directory, 'nessie-executor-runtime'), executorBundlePath: join(directory, 'nessie-executor.cjs'),
    manifest: { format: 1, nodeExecutable: 'nessie-executor-runtime', nodeVersion: '22.23.1' } }
  await finishMacManagedManifest(runtime)
  return { root, runtime }
}
const cleanup = async (root) => {
  await chmod(root, 0o755)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await cleanup(join(root, entry.name))
  }
  await rm(root, { recursive: true, force: true })
}

test('Mac candidate binds signed byte hashes, readonly release and one retained machine barrier installer', async () => {
  const { root, runtime } = await fixture()
  try {
    const candidate = await stageMacManagedRelease(runtime.runtimeDirectory, join(root, 'payload'), join(root, 'scripts'))
    assert.match(candidate.releaseDigest, /^[a-f0-9]{64}$/u)
    assert.ok(candidate.root.endsWith(candidate.releaseDigest))
    assert.ok((await readFile(join(root, 'scripts/postinstall'), 'utf8')).includes('managed-custody-install'))
    const launcher = await readFile(join(root, 'payload/usr/local/bin/nessie-executor'), 'utf8')
    assert.ok(launcher.includes(`'${MAC_MANAGED_ROOT}/releases/${candidate.releaseDigest}/nessie-executor-native'`))
    assert.ok(launcher.includes('managed-runtime -- "$@"'))
    assert.equal((await stat(join(candidate.root, 'nessie-executor.cjs'))).mode & 0o222, 0)
    assert.equal((await stat(join(candidate.root, 'nessie-executor-native'))).mode & 0o222, 0)
  } finally { await cleanup(root) }
})

test('Mac candidate refuses modified bytes rather than rewriting their authority manifest', async () => {
  const { root, runtime } = await fixture()
  try {
    await writeFile(runtime.nodePath, 'replacement after signature')
    await assert.rejects(stageMacManagedRelease(runtime.runtimeDirectory, join(root, 'payload'), join(root, 'scripts')),
      /does not match/u)
  } finally { await cleanup(root) }
})
