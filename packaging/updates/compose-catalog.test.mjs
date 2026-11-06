import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { composeManifest, targetFor } from './compose-catalog.mjs'

const commit = 'a'.repeat(40)

test('composes the Mac package from its own bytes at its immutable release URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-'))
  await writeFile(join(directory, 'NessieExecutor_0.9.1_arm64.dmg'), 'dmg bytes')
  const manifest = await composeManifest({ directory, channel: 'preview', sequence: 1, version: '0.9.1',
    sourceCommit: commit, now: Date.UTC(2026, 10, 6), days: 30 })
  assert.deepEqual(manifest.targets['darwin-arm64-dmg'], [{ name: 'NessieExecutor_0.9.1_arm64.dmg',
    url: 'https://github.com/UnlikeOtherAI/nessie-executor/releases/download/executor-v0.9.1/NessieExecutor_0.9.1_arm64.dmg',
    sha256: createHash('sha256').update('dmg bytes').digest('hex'), size: 9 }])
  assert.equal(manifest.expiresAt, '2026-12-06T00:00:00.000Z')
})

test('refuses packages it cannot map and malformed release facts', async () => {
  assert.throws(() => targetFor('NessieExecutor_0.9.0_arm64.dmg', '0.9.1'))
  assert.throws(() => targetFor('executor.msi', '0.9.1'))
  const directory = await mkdtemp(join(tmpdir(), 'catalog-'))
  await assert.rejects(composeManifest({ directory, channel: 'preview', sequence: 1, version: '0.9.1',
    sourceCommit: commit, now: 0, days: 30 }))
  await assert.rejects(composeManifest({ directory, channel: 'nightly', sequence: 1, version: '0.9.1',
    sourceCommit: commit, now: 0, days: 30 }))
})
