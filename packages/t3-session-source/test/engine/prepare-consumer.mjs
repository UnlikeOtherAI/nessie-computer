import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { preparePackageHistoryFixture } from './history-fixture.mjs'

// Opt-in preparation only. pnpm owns packing, lock creation and the separate frozen install.
const [archive, directory] = process.argv.slice(2)
if (process.argv.length !== 4 || !archive.endsWith('.tgz')) {
  throw new Error('Usage: node prepare-consumer.mjs <own-package.tgz> <fresh-owned-directory>')
}
const root = resolve(import.meta.dirname, '../..')
const destination = resolve(directory)
await mkdir(destination, { recursive: true })
await writeFile(resolve(destination, 'package.json'), `${JSON.stringify({
  name: 'normal-t3-session-engine-consumer', private: true, type: 'module', packageManager: 'pnpm@10.22.0',
  dependencies: { '@nessie/t3-session-source': `file:${resolve(archive).replaceAll('\\', '/')}`,
    effect: '4.1.2', '@effect/platform-node': '4.1.2' },
  devDependencies: { typescript: '5.9.3', '@types/node': '24.12.4', esbuild: '0.25.12' },
}, null, 2)}\n`, { flag: 'wx' })
for (const file of ['runtime.mjs', 'composition.mjs', 'consumer.mts', 'containment.mjs', 'check-types.mjs', 'build-helper.mjs']) {
  await writeFile(resolve(destination, file), await readFile(resolve(import.meta.dirname, file)), { flag: 'wx' })
}
await preparePackageHistoryFixture(resolve(destination, 'history'), resolve(root, '../..'))
await writeFile(resolve(destination, 'history/run.mjs'),
  `import { runSessionHistoryProof } from './history.mjs';\nconsole.log(JSON.stringify(await runSessionHistoryProof(${JSON.stringify(resolve(destination, 'history'))})));\n`,
  { flag: 'wx' })
console.log(JSON.stringify({ directory: destination, package: '@nessie/t3-session-source', ordinaryPackageImports: true }))
