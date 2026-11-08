import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { buildSessionEngineModule } from './build.mjs'

const tools = fileURLToPath(new URL('.', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const [sourceRepository, outputPath, contractsCommit, privacyCommit, privacyManifestSha256] = process.argv.slice(2)
if (process.argv.length !== 7 || !sourceRepository || !outputPath
  || !/^[a-f0-9]{40}$/u.test(contractsCommit ?? '') || !/^[a-f0-9]{40}$/u.test(privacyCommit ?? '')
  || !/^[a-f0-9]{64}$/u.test(privacyManifestSha256 ?? '')) {
  throw new Error('Expected source/output plus explicit committed contracts, privacy and privacy manifest identities.')
}
const committed = (commit, path) => execFileSync('git', ['--no-replace-objects', 'show', `${commit}:${path}`], {
  cwd: resolve(tools, '../..'), windowsHide: true, maxBuffer: 4 * 1024 * 1024,
})
const input = committed(contractsCommit, 'packages/t3-session-source/input.mjs')
const currentInput = new URL('../../packages/t3-session-source/input.mjs', import.meta.url)
if (hash(await readFile(currentInput)) !== hash(input)) throw new Error('Current contract helper differs from selected commit.')
const { sessionContractsAliasPlugin } = await import(currentInput.href)
const tree = ts.createSourceFile('input.mjs', input.toString('utf8'), ts.ScriptTarget.Latest, true)
let sourceEntry
const visit = node => {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'T3_CONTRACTS_SOURCE_ENTRY'
    && node.initializer && ts.isStringLiteral(node.initializer)) sourceEntry = node.initializer.text
  ts.forEachChild(node, visit)
}
visit(tree)
if (sourceEntry !== 't3-source:packages/contracts/src/index.ts') throw new Error('Committed T01 entry changed.')
const privacy = committed(privacyCommit, 'patches/t3-session/requests/boundary-patches.json')
if (hash(privacy) !== privacyManifestSha256) {
  throw new Error('Committed request privacy manifest changed.')
}
const output = resolve(outputPath)
const result = await buildSessionEngineModule({ sourceRepository, outputPath: output,
  entryPoint: resolve(tools, 'core/CoBuildProof.ts'),
  contractsAliasPlugin: sessionContractsAliasPlugin,
  additionalPatchFamilies: [{ id: 'request-privacy', bytes: privacy }] })
const record = { contractsCommit, contractsInputSha256: hash(input), sourceEntry,
  privacyCommit, privacyManifestSha256: hash(privacy), contractsHookExecuted: true,
  selectedAbsoluteDependencyDirectory: tools, ...result }
await writeFile(`${output}.co-build.json`, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
await writeFile(`${output}.request-privacy.json`, privacy, { flag: 'wx' })
process.stdout.write(`${JSON.stringify(record)}\n`)
