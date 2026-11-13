import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { patchClaudeSdk } from './patch.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const privateDeclaration = `import type {Options,Query,SDKUserMessage,SpawnOptions,Transport}
 from '@anthropic-ai/claude-agent-sdk';
import type {Readable} from 'node:stream';
export declare function createSessionNativeQuery(options:Options,owner:{
 capture(encoded:string):object;prompt(token:object):object;
 open(descriptor:SpawnOptions,parser:(this:{processStdout:Readable;waitForExit():Promise<void>})
 =>ReturnType<Transport['readMessages']>):Transport;
}):{query:Query;encodePrompt(message:SDKUserMessage):string};
`

/** The SDK and capsule join the same unpublished package generation. Exact
 * upstream bytes and all authored/compiler inputs are recorded before publish. */
export async function buildSessionClaudeSdk(outputDirectory, { check = false } = {}) {
  const require = createRequire(import.meta.url)
  const sdk = require.resolve('@anthropic-ai/claude-agent-sdk')
  const source = await readFile(sdk)
  const metadata = JSON.parse(await readFile(resolve(dirname(sdk), 'package.json'), 'utf8'))
  if (metadata.version !== '0.3.316' || metadata.claudeCodeVersion !== '2.1.316') {
    throw new Error('SESSION_CLAUDE_SDK_VERSION_MISMATCH')
  }
  const patched = patchClaudeSdk(source)
  const generation = resolve(root, '../.artifacts/claude-sdk-builds', randomUUID())
  const output = resolve(outputDirectory, 'claude-sdk')
  await mkdir(resolve(generation, 'upstream'), { recursive: true })
  const runtime = await readFile(resolve(root, 'runtime.ts'))
  await writeFile(resolve(generation, 'runtime.ts'), runtime)
  await writeFile(resolve(generation, 'upstream/sdk.d.mts'), privateDeclaration)
  const options = {
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noImplicitOverride: true,
    skipLibCheck: false, declaration: true, noEmit: check, outDir: output, rootDir: generation,
    types: ['node'], typeRoots: [resolve(root, '../node_modules/@types')],
  }
  const program = ts.createProgram([resolve(generation, 'runtime.ts')], options)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, {
    getCurrentDirectory: () => generation, getCanonicalFileName: name => name, getNewLine: () => '\n',
  }))
  const authoredInputs = {}
  for (const file of ['build.mjs', 'patch.mjs', 'runtime.ts']) authoredInputs[file] = digest(await readFile(resolve(root, file)))
  const provenance = { format: 1, name: metadata.name, version: metadata.version,
    claudeCodeVersion: metadata.claudeCodeVersion, sourceSha256: digest(source), patchedSha256: digest(patched.source),
    edits: patched.edits, authoredInputs, compiler: ts.version, libraryChecks: true,
    declarationSha256: digest(privateDeclaration),
    dependencyLockSha256: digest(await readFile(resolve(root, '../pnpm-lock.yaml'))),
    typeInputs: Object.fromEntries(program.getSourceFiles().map(file => [
      file.fileName.startsWith(generation.replaceAll('\\', '/'))
        ? relative(generation, file.fileName).replaceAll('\\', '/')
        : relative(resolve(root, '..'), file.fileName).replaceAll('\\', '/'), digest(file.text),
    ]).sort(([left], [right]) => left.localeCompare(right, 'en'))), outputs: {} }
  if (check) return provenance
  const result = program.emit()
  if (result.emitSkipped || result.diagnostics.length) throw new Error('SESSION_CLAUDE_EMIT_FAILED')
  await mkdir(resolve(output, 'upstream'), { recursive: true })
  await writeFile(resolve(output, 'upstream/sdk.mjs'), patched.source)
  await writeFile(resolve(output, 'upstream/sdk.d.mts'), privateDeclaration)
  for (const file of ['README.md', 'LICENSE.md']) {
    const bytes = await readFile(resolve(dirname(sdk), file))
    await writeFile(resolve(output, 'upstream', file), bytes)
    provenance.outputs[`upstream/${file}`] = digest(bytes)
  }
  for (const file of ['runtime.js', 'runtime.d.ts', 'upstream/sdk.mjs', 'upstream/sdk.d.mts']) {
    provenance.outputs[file] = digest(await readFile(resolve(output, file)))
  }
  await writeFile(resolve(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n')
  return provenance
}
