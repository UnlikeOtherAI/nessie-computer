import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

/** Reuse the committed synthetic assertions against package imports, with no source/runtime resolver. */
export const preparePackageHistoryFixture = async (directory, executorRoot) => {
  await mkdir(directory, { recursive: true })
  const inputs = {}
  for (const file of ['HistoryProof.ts', 'HistoryFixture.ts', 'HistoryReadsProof.ts', 'HistorySyncProof.ts']) {
    const original = await readFile(resolve(executorRoot, 'packaging/session-engine/core', file), 'utf8')
    const hash = bytes => createHash('sha256').update(bytes).digest('hex')
    const source = original
      .replaceAll("'t3-source:packages/contracts/src/index.ts'", "'@nessie/t3-session-source/contracts'")
      .replaceAll("import * as Forks from 't3-source:apps/server/src/orchestration-v2/ThreadForkService.ts'",
        "import { Forks } from '@nessie/t3-session-source/engine'")
      .replaceAll(/'\.\/(?:StateLayers|ReadLayers|EngineLayers)\.ts'/gu, "'@nessie/t3-session-source/engine'")
    if (source.includes('t3-source:')) throw new Error('Normal history fixture contains a source alias.')
    await writeFile(resolve(directory, file), source)
    inputs[file] = { original: hash(original), consumer: hash(source) }
  }
  const result = await build({ absWorkingDir: directory, entryPoints: ['HistoryProof.ts'],
    outfile: resolve(directory, 'history.mjs'), bundle: true, format: 'esm', platform: 'node',
    target: 'node22.19', packages: 'external', metafile: true })
  if (Object.keys(result.metafile.inputs).length !== 4) throw new Error('Normal history fixture bundled another engine.')
  await writeFile(resolve(directory, 'inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`)
}
