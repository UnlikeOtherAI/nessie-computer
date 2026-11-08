import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { composeManifest } from '../packaging/updates/compose-catalog.mjs'
import { publishCatalog } from '../packaging/updates/catalog-history.mjs'
import { signCatalog } from '../packaging/updates/sign-catalog.mjs'

type Release = { draft: boolean; immutable: boolean; hasCatalog: boolean;
  assets: { name: string; size: number; digest: string }[] }
const setup = async (expired = false) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-catalog-history-'))
  const version = '1.0.3', sourceCommit = 'a'.repeat(40), channel = 'stable'
  for (const name of [`NessieExecutor_${version}_x64.msi`, `NessieExecutor_${version}_arm64.dmg`,
    `nessie-executor_${version}_amd64.deb`, `nessie-executor_${version}_amd64.deb.asc`,
    `nessie-executor_${version}_x86_64.rpm`, `nessie-executor_${version}_x86_64.rpm.asc`]) {
    await writeFile(join(directory, name), 'fixture package bytes: ' + name)
  }
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const now = Date.parse('2026-11-08T12:00:00Z')
  const previousTime = now - (expired ? 45 : 1) * 86_400_000
  const current = await composeManifest({ directory, version, sourceCommit, channel, sequence: 1,
    now: previousTime, days: 30 })
  const releases = new Map<string, Release>([
    ['executor-v' + version, { draft: false, immutable: true, hasCatalog: false,
      assets: Object.values(current.targets).flat().map(asset => ({
        name: asset.name, size: asset.size, digest: 'sha256:' + asset.sha256,
      })) }],
    ['update-catalog-stable', { draft: false, immutable: false, hasCatalog: true, assets: [] }],
  ])
  const catalogs = new Map<string, string>([['update-catalog-stable', signCatalog(current, privateKey, publicKey, previousTime)]])
  let archives = 0, writes = 0, failChannel = false
  const github = {
    getRelease: async (tag: string) => releases.get(tag),
    verifyTag: async (_tag: string, source: string) => { assert.equal(source, sourceCommit) },
    readCatalog: async (tag: string) => { const value = catalogs.get(tag); assert.ok(value); return value },
    archiveCatalog: async (input: { tag: string; envelope: string }) => {
      archives++
      catalogs.set(input.tag, input.envelope)
      releases.set(input.tag, { draft: false, immutable: true, hasCatalog: true, assets: [] })
    },
    replaceChannelCatalog: async (tag: string, envelope: string) => {
      writes++
      if (failChannel) { failChannel = false; throw new Error('channel upload interrupted') }
      catalogs.set(tag, envelope)
    },
  }
  return { directory, releases, catalogs, github, counts: () => ({ archives, writes }),
    interrupt: () => { failChannel = true },
    input: { directory, version, sourceCommit, channel, sequence: 2, now, days: 30, privateKey, publicKey },
    close: () => rm(directory, { recursive: true, force: true }) }
}

test('a channel upload interrupted after archival resumes with identical immutable bytes and no signing key', async () => {
  const fixture = await setup()
  try {
    fixture.interrupt()
    await assert.rejects(publishCatalog(fixture.input, fixture.github), /interrupted/u)
    const archived = fixture.catalogs.get('update-catalog-stable-2')
    assert.ok(archived)
    const result = await publishCatalog({ ...fixture.input, now: fixture.input.now + 60_000, privateKey: undefined },
      fixture.github)
    assert.equal(result.reused, true)
    assert.equal(fixture.catalogs.get('update-catalog-stable'), archived)
    assert.deepEqual(fixture.counts(), { archives: 1, writes: 2 })
    await publishCatalog({ ...fixture.input, privateKey: undefined }, fixture.github)
    assert.deepEqual(fixture.counts(), { archives: 1, writes: 2 }, 'an already published channel needs no second write')
  } finally { await fixture.close() }
})

test('an expired signed channel retains its replay floor while a fresh higher sequence can be published', async () => {
  const fixture = await setup(true)
  try {
    await publishCatalog(fixture.input, fixture.github)
    await assert.rejects(publishCatalog({ ...fixture.input, sequence: 1 }, fixture.github), /replayed_manifest/u)
    assert.deepEqual(fixture.counts(), { archives: 1, writes: 1 })
  } finally { await fixture.close() }
})

test('catalogs cannot be signed over substituted package bytes or a mutable version release', async () => {
  const fixture = await setup()
  try {
    await writeFile(join(fixture.directory, 'NessieExecutor_1.0.3_x64.msi'), 'substituted bytes')
    await assert.rejects(publishCatalog(fixture.input, fixture.github), /immutable GitHub release digest/u)
    fixture.releases.get('executor-v1.0.3')!.immutable = false
    await assert.rejects(publishCatalog(fixture.input, fixture.github), /published immutable release/u)
    assert.deepEqual(fixture.counts(), { archives: 0, writes: 0 })
  } finally { await fixture.close() }
})

test('missing or immutable moving channels fail before any archive or pointer mutation', async () => {
  const fixture = await setup()
  try {
    fixture.releases.get('update-catalog-stable')!.immutable = true
    await assert.rejects(publishCatalog(fixture.input, fixture.github), /published and mutable/u)
    fixture.releases.delete('update-catalog-stable')
    await assert.rejects(publishCatalog(fixture.input, fixture.github), /published and mutable/u)
    assert.deepEqual(fixture.counts(), { archives: 0, writes: 0 })
  } finally { await fixture.close() }
})

test('a draft catalog with verified signed bytes finishes publication without a replacement signature', async () => {
  const fixture = await setup()
  try {
    const candidate = await composeManifest(fixture.input)
    const envelope = signCatalog(candidate, fixture.input.privateKey, fixture.input.publicKey, fixture.input.now)
    fixture.releases.set('update-catalog-stable-2', { draft: true, immutable: false, hasCatalog: true, assets: [] })
    fixture.catalogs.set('update-catalog-stable-2', envelope)
    await publishCatalog({ ...fixture.input, privateKey: undefined }, fixture.github)
    assert.equal(fixture.catalogs.get('update-catalog-stable'), envelope)
    assert.deepEqual(fixture.counts(), { archives: 1, writes: 1 })
  } finally { await fixture.close() }
})

test('a substituted signed current payload is rejected before its sequence can become authority', async () => {
  const fixture = await setup()
  try {
    const envelope = JSON.parse(fixture.catalogs.get('update-catalog-stable')!) as { payload: string }
    const payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString()) as { sequence: number }
    payload.sequence = 50
    envelope.payload = Buffer.from(JSON.stringify(payload)).toString('base64')
    fixture.catalogs.set('update-catalog-stable', JSON.stringify(envelope))
    await assert.rejects(publishCatalog(fixture.input, fixture.github), /invalid_signature/u)
    assert.deepEqual(fixture.counts(), { archives: 0, writes: 0 })
  } finally { await fixture.close() }
})
