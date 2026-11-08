import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const root = resolve(process.argv[2])
const parent = resolve(root, '.artifacts/composite-consumer')
await mkdir(parent, { recursive: true })
const project = await mkdtemp(resolve(parent, 'run-'))
await mkdir(resolve(project, 'src'))
await writeFile(resolve(project, 'src/consumer.mts'), await readFile(new URL('./consumer.mts', import.meta.url)))
const config = {
  compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    noUnusedLocals: true, noUnusedParameters: true, skipLibCheck: false,
    composite: true, declaration: true, rootDir: './src', outDir: './dist',
    tsBuildInfoFile: './build.tsbuildinfo', types: ['node'],
  },
  files: ['./src/consumer.mts'],
}
await writeFile(resolve(project, 'tsconfig.json'), `${JSON.stringify(config, null, 2)}\n`)
const result = spawnSync(process.execPath, ['--max-old-space-size=5120', require.resolve('typescript/bin/tsc'),
  '--build', resolve(project, 'tsconfig.json')],
{ windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
assert.equal(result.error, undefined)
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
const infoPath = resolve(project, 'build.tsbuildinfo')
const info = JSON.parse(await readFile(infoPath, 'utf8'))
const files = info.fileNames.map(path => resolve(dirname(infoPath), path).replaceAll('\\', '/'))
const consumer = resolve(project, 'src/consumer.mts').replaceAll('\\', '/')
for (const path of files) {
  assert.ok(path === consumer || /\.d\.[cm]?ts$/u.test(path), `Implementation reached by composite consumer: ${path}`)
}
const contractFiles = files.filter(path => path.includes('/types/source/') && path.endsWith('.d.ts'))
// withRecordIdTable is an implementation helper; declaration emit erases its import.
const selection = JSON.parse(await readFile(new URL('../../selection.json', import.meta.url), 'utf8'))
const expected = selection.map(({ path }) => path.split('/').at(-1).replace('.ts', '.d.ts').toLowerCase())
  .filter(path => path !== 'orchestrationv2idtable.d.ts').sort()
assert.deepEqual(contractFiles.map(path => path.split('/').at(-1).toLowerCase()).sort(), expected)
const declaration = await readFile(resolve(project, 'dist/consumer.d.mts'), 'utf8')
assert.ok(declaration.includes('@nessie/t3-session-source/contracts'))
console.log(JSON.stringify({ node: process.versions.node, composite: true, rootDir: 'src', libraryChecks: true,
  sourceFiles: files.length, contractDeclarations: contractFiles.length, implementationFiles: 0, project }))
