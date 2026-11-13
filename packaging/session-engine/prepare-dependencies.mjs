import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareSessionEngineSource, T3_SESSION_ENGINE_SOURCE } from './source.mjs'
import { readSessionEngineSnapshot } from './snapshot.mjs'

const run = async () => {
  if (process.argv.length !== 3) throw new Error('Usage: node prepare-dependencies.mjs <pinned Git repository>')
  const tools = fileURLToPath(new URL('.', import.meta.url))
  const archivePath = resolve(tools, `.artifacts/source-${T3_SESSION_ENGINE_SOURCE.archiveSha256}.tar`)
  const identity = await prepareSessionEngineSource({ sourceRepository: process.argv[2], archivePath })
  const snapshot = await readSessionEngineSnapshot(archivePath)
  const patches = Object.keys(T3_SESSION_ENGINE_SOURCE.files).filter(path => path.startsWith('patches/'))
  for (const file of patches) {
    const output = resolve(tools, '.artifacts/upstream-patches', basename(file))
    const bytes = snapshot.read(file)
    const expected = T3_SESSION_ENGINE_SOURCE.files[file]
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('SESSION_ENGINE_PATCH_IDENTITY_MISMATCH')
    await mkdir(dirname(output), { recursive: true })
    const existing = await readFile(output).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (existing && createHash('sha256').update(existing).digest('hex') !== expected) {
      throw new Error('SESSION_ENGINE_PATCH_OUTPUT_CONFLICT')
    }
    if (!existing) await writeFile(output, bytes, { flag: 'wx', mode: 0o600 })
  }
  process.stdout.write(`${JSON.stringify({ ...identity, preparedDependencyPatches: patches.length })}\n`)
}
run().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
