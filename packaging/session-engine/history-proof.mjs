import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readSessionEngineSnapshot } from './snapshot.mjs'
import { prepareSessionEngineSnapshot } from './engine-snapshot.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const output = resolve(process.argv[2])
const provenance = JSON.parse(await readFile(`${output}.provenance.json`, 'utf8'))
const original = await readSessionEngineSnapshot(`${output}.source.tar`)
const { snapshot, manifestBytes } = prepareSessionEngineSnapshot(original)
if (provenance.kind !== 'synthetic-history-proof' || provenance.bundleSha256 !== hash(await readFile(output))
  || provenance.sourceIdentity.orderedPatchesSha256 !== snapshot.identity.orderedPatchesSha256
  || hash(await readFile(`${output}.patches.json`)) !== hash(manifestBytes)
  || provenance.dependencyLockSha256 !== hash(await readFile(new URL('./pnpm-lock.yaml', import.meta.url)))
  || provenance.buildManifestSha256 !== hash(await readFile(new URL('./package.json', import.meta.url)))) {
  throw new Error('Synthetic history proof provenance mismatch.')
}
for (const [file, expected] of Object.entries(provenance.sourceInputs)) {
  if (hash(snapshot.read(file)) !== expected) throw new Error('Synthetic history proof source mismatch.')
}
await mkdir(dirname(output), { recursive: true })
const directory = await mkdtemp(join(dirname(output), 'synthetic-history-'))
const { runSessionHistoryProof } = await import(pathToFileURL(output).href)
const result = await runSessionHistoryProof(directory)
process.stdout.write(`${JSON.stringify({ ...result, bundleSha256: provenance.bundleSha256 })}\n`)
