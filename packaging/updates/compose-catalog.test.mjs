import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { composeManifest, targetFor } from './compose-catalog.mjs'

const version = '1.0.0'
const facts = { channel: 'preview', sequence: 2, version, sourceCommit: 'a'.repeat(40),
  now: Date.UTC(2026, 10, 7), days: 30 }
const packages = {
  'windows-x64-msi': [`NessieExecutor_${version}_x64.msi`],
  'darwin-arm64-dmg': [`NessieExecutor_${version}_arm64.dmg`],
  'linux-x64-deb': [`nessie-executor_${version}_amd64.deb`, `nessie-executor_${version}_amd64.deb.asc`],
  'linux-x64-rpm': [`nessie-executor_${version}_x86_64.rpm`, `nessie-executor_${version}_x86_64.rpm.asc`],
}
const fixture = async (t, names) => {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const name of names) await writeFile(join(directory, name), `bytes for ${name}`)
  return directory
}

test('stable catalog includes every installer and Linux signature from their actual bytes', async t => {
  const directory = await fixture(t, Object.values(packages).flat())
  const manifest = await composeManifest({ ...facts, directory, channel: 'stable' })
  assert.deepEqual(Object.keys(manifest.targets).sort(), Object.keys(packages).sort())
  for (const [target, names] of Object.entries(packages)) {
    assert.deepEqual(manifest.targets[target].map(asset => asset.name).sort(), [...names].sort())
    for (const asset of manifest.targets[target]) {
      const bytes = Buffer.from(`bytes for ${asset.name}`)
      assert.equal(asset.url,
        `https://github.com/UnlikeOtherAI/nessie-executor/releases/download/executor-v${version}/${asset.name}`)
      assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'))
      assert.equal(asset.size, bytes.length)
    }
  }
  assert.equal(manifest.expiresAt, '2026-12-07T00:00:00.000Z')
})

test('stable composition refuses a release missing any supported platform', async t => {
  for (const missing of Object.keys(packages)) {
    const names = Object.entries(packages).filter(([target]) => target !== missing).flatMap(([, names]) => names)
    const directory = await fixture(t, names)
    await assert.rejects(composeManifest({ ...facts, directory, channel: 'stable' }),
      new RegExp(`Stable releases require ${missing}`))
  }
})

test('preview can select one complete platform without enabling other platforms', async t => {
  for (const [target, names] of Object.entries(packages)) {
    const directory = await fixture(t, names)
    const manifest = await composeManifest({ ...facts, directory })
    assert.deepEqual(Object.keys(manifest.targets), [target])
  }
})

test('Linux catalogs require both package and matching detached signature', async t => {
  for (const target of ['linux-x64-deb', 'linux-x64-rpm']) {
    for (const name of packages[target]) {
      const directory = await fixture(t, [name])
      await assert.rejects(composeManifest({ ...facts, directory }), /requires its package and detached signature/u)
    }
  }
})

test('refuses foreign versions, architectures, filenames and empty assets', async t => {
  for (const name of ['NessieExecutor_0.9.1_arm64.dmg', 'executor.msi',
    'nessie-executor_1.0.0_arm64.deb', 'SHA256SUMS.asc']) {
    assert.throws(() => targetFor(name, version), /not a supported update package/u)
  }
  const directory = await fixture(t, packages['darwin-arm64-dmg'])
  await writeFile(join(directory, packages['darwin-arm64-dmg'][0]), '')
  await assert.rejects(composeManifest({ ...facts, directory }), /is empty/u)
})

test('refuses malformed release facts and an empty release', async t => {
  const directory = await fixture(t, packages['darwin-arm64-dmg'])
  for (const invalid of [{ version: undefined }, { version: '../1.0.0' }, { version: '1.0.0-preview' },
    { sourceCommit: 'abc' }, { channel: 'nightly' }, { sequence: 0 }, { days: 91 }]) {
    await assert.rejects(composeManifest({ ...facts, directory, ...invalid }))
  }
  const empty = await fixture(t, [])
  await assert.rejects(composeManifest({ ...facts, directory: empty }), /has no update packages/u)
})

test('release CLI writes a complete stable manifest and preserves an existing output', async t => {
  const directory = await fixture(t, Object.values(packages).flat())
  const output = join(directory, 'manifest.json')
  const command = fileURLToPath(new URL('./compose-catalog.mjs', import.meta.url))
  const options = { env: { ...process.env, CHANNEL: 'stable', VERSION: version,
    SOURCE_COMMIT: facts.sourceCommit, SEQUENCE: '2', VALID_DAYS: '30' } }
  await promisify(execFile)(process.execPath, [command, directory, output], options)
  const bytes = await readFile(output, 'utf8')
  const manifest = JSON.parse(bytes)
  assert.deepEqual(Object.keys(manifest.targets).sort(), Object.keys(packages).sort())
  assert.equal(manifest.sourceCommit, facts.sourceCommit)
  // Keep generated metadata separate from the package-only input directory.
  const next = await fixture(t, Object.values(packages).flat())
  await assert.rejects(promisify(execFile)(process.execPath, [command, next, output], options), /EEXIST/u)
  assert.equal(await readFile(output, 'utf8'), bytes)
})
