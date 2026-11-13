import assert from 'node:assert/strict'
import { resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { build } from 'esbuild'
import { readSessionEngineSnapshot, createSessionEngineSourceResolver, sessionContractsAliasPlugin,
  sessionEngineSourcePlugin, T3_CONTRACTS_SOURCE_ENTRY } from '@nessie/t3-session-source/build'

const source = await readSessionEngineSnapshot(resolve(process.argv[2]))
assert.equal(source.identity.archiveSha256, '6ec4dc60aa5b92dabbf69c55b408b1db87d77d0a132cbc1fbca61daa0b4f7096')
const resolver = createSessionEngineSourceResolver(source)
assert.equal(resolver.resolve(T3_CONTRACTS_SOURCE_ENTRY).path, 'packages/contracts/src/index.ts')
const result = await build({ absWorkingDir: process.cwd(), stdin: { contents: `
  import { ThreadId as byAlias } from '@nessie/t3-session-source/contracts';
  import { ThreadId as bySource } from '${T3_CONTRACTS_SOURCE_ENTRY}';
  export const shared = byAlias === bySource;`, resolveDir: process.cwd() },
bundle: true, format: 'esm', platform: 'browser', write: false, metafile: true,
plugins: [sessionContractsAliasPlugin({ dependencyDirectory: process.cwd() }),
  sessionEngineSourcePlugin({ snapshot: source, dependencyDirectory: process.cwd(), dependencies: ['effect'] })] })
const prefix = `${realpathSync(process.cwd()).toLowerCase()}${sep}`
for (const input of Object.keys(result.metafile.inputs)) {
  if (input === '<stdin>' || input.startsWith('nessie-t3-source:')) continue
  assert.ok(realpathSync(resolve(input)).toLowerCase().startsWith(prefix), `Bundler input escaped consumer: ${input}`)
}
assert.ok(Object.values(result.metafile.outputs).every(output => output.imports.length === 0))
assert.equal((await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`))
  .shared, true)
console.log(JSON.stringify({ packedBuildHelperExecuted: true, verifiedCapsuleRead: true,
  actualEsbuildAliasIdentity: true, dependencyRoot: process.cwd() }))
