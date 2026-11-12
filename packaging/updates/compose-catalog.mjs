// Machine-only release interface. Hash packages attached to an immutable release.
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { releaseVersion } from '../cli/release-plan.mjs'

// Old installed updaters require this exact alias; GitHub redirects it after the rename.
const RELEASES = 'https://github.com/UnlikeOtherAI/nessie-executor/releases/download'
const packagesFor = version => [
  { name: `NessieExecutor_${version}_x64.msi`, target: 'windows-x64-msi' },
  { name: `NessieExecutor_${version}_arm64.dmg`, target: 'darwin-arm64-dmg' },
  { name: `nessie-executor_${version}_amd64.deb`, target: 'linux-x64-deb', signature: true },
  { name: `nessie-executor_${version}_x86_64.rpm`, target: 'linux-x64-rpm', signature: true },
]

// These names and companion signatures match the installed native adapters.
export const targetFor = (name, version) => {
  releaseVersion(version)
  const entry = packagesFor(version).find(entry => name === entry.name
    || entry.signature && name === `${entry.name}.asc`)
  if (!entry) throw new Error(`${name} is not a supported update package for ${version}.`)
  return entry.target
}

export async function composeManifest({ directory, channel, sequence, version, sourceCommit, now, days }) {
  releaseVersion(version)
  if (!['stable', 'preview'].includes(channel)) throw new Error('Channel is stable or preview.')
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('The source commit is a full revision.')
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('The sequence is a positive integer.')
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) throw new Error('Validity is 1 to 90 days.')
  const targets = {}
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const { name } = entry
    const target = targetFor(name, version)
    if (!entry.isFile()) throw new Error(`${name} must be a regular release asset.`)
    const bytes = await readFile(join(directory, name))
    if (bytes.length === 0) throw new Error(`${name} is empty.`)
    ;(targets[target] ??= []).push({ name, url: `${RELEASES}/executor-v${version}/${name}`,
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
  }
  for (const entry of packagesFor(version)) {
    const assets = targets[entry.target]
    if (!assets) {
      if (channel === 'stable') throw new Error(`Stable releases require ${entry.target}.`)
      continue
    }
    const names = new Set(assets.map(asset => asset.name))
    if (!names.has(entry.name) || entry.signature && !names.has(`${entry.name}.asc`)) {
      throw new Error(`${entry.target} requires its package and detached signature.`)
    }
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
