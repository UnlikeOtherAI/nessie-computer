import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = realpathSync(dirname(fileURLToPath(import.meta.url)))
const mode = process.argv[2]
assert.ok(mode === 'Bundler' || mode === 'NodeNext')
const program = ts.createProgram([resolve(root, 'consumer.mts')], {
  noEmit: true, strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
  target: ts.ScriptTarget.ES2022, noUnusedLocals: true, noUnusedParameters: true,
  module: mode === 'NodeNext' ? ts.ModuleKind.NodeNext : ts.ModuleKind.ESNext,
  moduleResolution: mode === 'NodeNext' ? ts.ModuleResolutionKind.NodeNext : ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true, resolveJsonModule: true, types: ['node'],
})
for (const source of program.getSourceFiles()) {
  const path = realpathSync(source.fileName)
  assert.ok(path.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`),
    `Type consumer escaped its own installation: ${path}`)
}
const diagnostics = ts.getPreEmitDiagnostics(program)
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => '\n',
}))
console.log(JSON.stringify({ resolution: mode, strict: true, libraryChecks: true,
  sourceFiles: program.getSourceFiles().length, allFilesWithinFreshConsumer: true }))
