// A versioned catalog is immutable history; the channel is a signed moving pointer.
import { createHash } from 'node:crypto'
import { composeManifest } from './compose-catalog.mjs'
import { signCatalog } from './sign-catalog.mjs'
import { verifyUpdateManifest } from '../../src/updates/manifest.ts'
import { EXECUTOR_UPDATE_PUBLIC_KEY } from '../../src/updates/trusted-key.ts'

// An expired channel still supplies an authenticated replay floor. Its original
// publication time is used only for this read, never for accepting an install.
export const catalogFloor = (envelope, channel, publicKey) => {
  if (Buffer.byteLength(envelope) > 200_000) throw new Error('The current catalog is too large.')
  const payload = JSON.parse(Buffer.from(JSON.parse(envelope).payload, 'base64').toString('utf8'))
  const now = Date.parse(payload.publishedAt)
  if (!Number.isFinite(now)) throw new Error('The current catalog has no publication time.')
  return verifyUpdateManifest(envelope, publicKey, { now, channel, highestSequence: 0 })
}

const inventory = targets => Object.entries(targets).sort(([a], [b]) => a.localeCompare(b))
  .map(([target, assets]) => [target, [...assets].sort((a, b) => a.name.localeCompare(b.name))])

const immutable = release => {
  if (!release || release.draft || release.immutable !== true) {
    throw new Error('A published immutable release is required.')
  }
}

export async function publishCatalog(input, github) {
  const { channel, version, sourceCommit, sequence, now = Date.now(),
    privateKey, publicKey = EXECUTOR_UPDATE_PUBLIC_KEY } = input
  // This checks the complete platform/file set and hashes before any publication.
  const expected = await composeManifest({ ...input, now, days: input.days ?? 30 })
  const versionRelease = await github.getRelease('executor-v' + version)
  immutable(versionRelease)
  await github.verifyTag('executor-v' + version, sourceCommit)
  for (const asset of Object.values(expected.targets).flat()) {
    const published = versionRelease.assets.filter(item => item.name === asset.name)
    if (published.length !== 1 || published[0].digest !== 'sha256:' + asset.sha256 || published[0].size !== asset.size) {
      throw new Error('A downloaded package differs from its immutable GitHub release digest.')
    }
  }
  const channelTag = 'update-catalog-' + channel
  const channelRelease = await github.getRelease(channelTag)
  if (!channelRelease || channelRelease.draft || channelRelease.immutable !== false) {
    throw new Error('The existing update channel must be published and mutable.')
  }
  const currentEnvelope = await github.readCatalog(channelTag)
  const current = catalogFloor(currentEnvelope, channel, publicKey)
  const archiveTag = channelTag + '-' + sequence
  const archive = await github.getRelease(archiveTag)
  if (archive && !archive.draft) immutable(archive)
  if (archive && !archive.draft && !archive.hasCatalog) {
    throw new Error('The immutable catalog archive has no catalog asset.')
  }

  const reused = Boolean(archive?.hasCatalog)
  const envelope = reused ? await github.readCatalog(archiveTag) : signCatalog(expected, privateKey, publicKey, now)
  const candidate = verifyUpdateManifest(envelope, publicKey, { now, channel,
    highestSequence: current.manifest.sequence, previousDigest: current.digest })
  if (candidate.manifest.version !== version || candidate.manifest.sourceCommit !== sourceCommit
    || candidate.manifest.sequence !== sequence
    || JSON.stringify(inventory(candidate.manifest.targets)) !== JSON.stringify(inventory(expected.targets))) {
    throw new Error('The catalog archive does not match the requested release assets.')
  }
  if (!archive || archive.draft) {
    await github.archiveCatalog({ tag: archiveTag, sourceCommit, envelope, existing: archive })
  }
  immutable(await github.getRelease(archiveTag))
  await github.verifyTag(archiveTag, sourceCommit)
  if (await github.readCatalog(archiveTag) !== envelope) {
    throw new Error('The immutable archive differs from the verified catalog bytes.')
  }
  // A failed channel upload can rerun with the same immutable bytes and no key.
  if (currentEnvelope !== envelope) await github.replaceChannelCatalog(channelTag, envelope)
  if (await github.readCatalog(channelTag) !== envelope) {
    throw new Error('The channel did not return the published catalog bytes.')
  }
  return { archiveTag, reused, sha256: createHash('sha256').update(envelope).digest('hex') }
}
