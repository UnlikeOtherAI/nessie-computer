import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import ts from 'typescript'

const [fixture, effectRoot, mode] = process.argv.slice(2)
assert.ok(fixture && effectRoot)
assert.ok(mode === 'nodenext' || mode === 'bundler')
const program = ts.createProgram([fixture], {
  moduleResolution: mode === 'nodenext' ? ts.ModuleResolutionKind.NodeNext : ts.ModuleResolutionKind.Bundler,
  module: mode === 'nodenext' ? ts.ModuleKind.NodeNext : ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2023, strict: true, noEmit: true, types: ['node'],
  exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
  paths: { effect: [resolve(effectRoot, 'dist/index.d.ts')], 'effect/*': [resolve(effectRoot, 'dist/*.d.ts')] },
})
const diagnostics = ts.getPreEmitDiagnostics(program)
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: x => x, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
}))
assert.ok(program.getSourceFiles().some(file => file.fileName.endsWith('/source/rpc.d.ts')))
assert.equal(program.getSourceFiles().some(file => file.fileName.endsWith('/source/rpc.ts')), false)
const effectFiles = program.getSourceFiles().filter(file => /[/\\]effect[/\\]dist[/\\]/u.test(file.fileName))
assert.ok(effectFiles.length > 0)
assert.ok(effectFiles.every(file => file.fileName.replaceAll('\\', '/').startsWith(effectRoot.replaceAll('\\', '/'))))
