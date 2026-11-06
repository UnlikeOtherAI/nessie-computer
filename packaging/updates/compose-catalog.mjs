// Machine-only release interface. Builds an unsigned update manifest from the
// assets already attached to an immutable executor-v<version> release, hashing
// the downloaded bytes rather than trusting supplied digests.
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RELEASES = 'https://github.com/UnlikeOtherAI/nessie-executor/releases/download'

// Only targets whose package shape the native installer accepts are mapped.
// Any other attached file stops composition rather than being silently left out.
export const targetFor = (name, version) => {
  if (name === `NessieExecutor_${version}_arm64.dmg`) return 'darwin-arm64-dmg'
  throw new Error(`${name} is not a supported update package for ${version}.`)
}

export async function composeManifest({ directory, channel, sequence, version, sourceCommit, now, days }) {
  if (!['stable', 'preview'].includes(channel)) throw new Error('Channel is stable or preview.')
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('The source commit is a full revision.')
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('The sequence is a positive integer.')
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) throw new Error('Validity is 1 to 90 days.')
  const targets = {}
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name)
    const target = targetFor(name, version)
    const bytes = await readFile(path)
    ;(targets[target] ??= []).push({ name, url: `${RELEASES}/executor-v${version}/${name}`,
      sha256: createHash('sha256').update(bytes).digest('hex'), size: (await stat(path)).size })
  }
  if (Object.keys(targets).length === 0) throw new Error('The release has no update packages.')
  return { format: 1, channel, sequence, version, sourceCommit,
    publishedAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86_400_000).toISOString(),
    minimumUpdaterProtocol: 1, targets }
}

async function main() {
  const [directory, output] = process.argv.slice(2)
  if (!directory || !output || process.argv.length !== 4) {
    throw new Error('Usage: node packaging/updates/compose-catalog.mjs <asset-directory> <manifest.json>')
  }
  const { CHANNEL, SEQUENCE, VERSION, SOURCE_COMMIT, VALID_DAYS } = process.env
  const manifest = await composeManifest({ directory: resolve(directory), channel: CHANNEL,
    sequence: Number(SEQUENCE), version: VERSION, sourceCommit: SOURCE_COMMIT, now: Date.now(),
    days: Number(VALID_DAYS ?? '30') })
  await writeFile(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
