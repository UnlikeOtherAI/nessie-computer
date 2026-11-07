import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { T3_SESSION_ENGINE_SOURCE } from './source.mjs'

const run = async () => {
  if (process.argv.length !== 3) throw new Error('Usage: node proof.mjs <built-synthetic-state-proof.mjs>')
  const path = resolve(process.argv[2])
  const provenance = JSON.parse(await readFile(`${path}.provenance.json`, 'utf8'))
  const bytes = await readFile(path)
  const tools = fileURLToPath(new URL('.', import.meta.url))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  if (provenance.kind !== 'synthetic-state-proof' || provenance.source.commit !== T3_SESSION_ENGINE_SOURCE.commit
    || provenance.source.archiveSha256 !== T3_SESSION_ENGINE_SOURCE.archiveSha256
    || provenance.source.tree !== T3_SESSION_ENGINE_SOURCE.tree || provenance.bundleSha256 !== hash(bytes)
    || provenance.dependencyLockSha256 !== hash(await readFile(resolve(tools, 'pnpm-lock.yaml')))
    || provenance.sourceIdentity.orderedPatchesSha256 !== hash(await readFile(resolve(tools, 'boundary-patches.json')))) {
    throw new Error('SESSION_ENGINE_PROOF_IDENTITY_MISMATCH')
  }
  const { runSessionStateProof } = await import(pathToFileURL(path).href)
  process.stdout.write(`${JSON.stringify(await runSessionStateProof())}\n`)
}
run().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
