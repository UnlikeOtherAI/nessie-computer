import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { createSessionEngineSourceResolver } from './resolver.mjs'
import { declarationWriter } from './declarations.mjs'
import { nameContractTypes } from './contract-names.mjs'

const tools = fileURLToPath(new URL('.', import.meta.url))
const slash = path => path.replaceAll('\\', '/')

/** Type-check the real source closure without writing upstream files into a checkout. */
export const typecheckSessionState = async (snapshot, entryPoint,
  { declarationDirectory, sharedContracts, assertAuthoredInputs, additionalEntries = {} } = {}) => {
  const { default: ts } = await import('typescript')
  const virtualRoot = `${slash(resolve(tools, '.virtual-t3-source'))}/`
  const sourcePath = path => {
    const normalized = slash(path)
    return normalized.toLowerCase().startsWith(virtualRoot.toLowerCase())
      ? normalized.slice(virtualRoot.length) : undefined
  }
  const resolver = createSessionEngineSourceResolver(snapshot)
  const paths = new Set(snapshot.files)
  const options = {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: !declarationDirectory, declaration: Boolean(declarationDirectory),
    emitDeclarationOnly: Boolean(declarationDirectory), outDir: resolve(tools, '.virtual-declarations'),
    allowImportingTsExtensions: true, resolveJsonModule: true, verbatimModuleSyntax: true,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noImplicitOverride: true,
    skipLibCheck: false, allowSyntheticDefaultImports: true, esModuleInterop: true,
    types: ['node'], typeRoots: [resolve(tools, 'node_modules/@types')],
  }
  const host = ts.createCompilerHost(options)
  let contractSources = new Map()
  const diskRead = host.readFile.bind(host)
  const diskExists = host.fileExists.bind(host)
  const diskDirectoryExists = host.directoryExists?.bind(host)
  host.readFile = path => {
    if (contractSources.has(path)) return contractSources.get(path)
    const source = sourcePath(path)
    return source === undefined ? diskRead(path) : paths.has(source) ? snapshot.read(source).toString('utf8') : undefined
  }
  host.fileExists = path => {
    const source = sourcePath(path)
    return source === undefined ? diskExists(path) : paths.has(source)
  }
  host.directoryExists = path => {
    const source = sourcePath(`${slash(path)}/`)
    if (source === undefined) return diskDirectoryExists?.(path) ?? false
    return snapshot.files.some(file => file.startsWith(source))
  }
  host.getSourceFile = (path, languageVersion, onError) => {
    try {
      const contents = host.readFile(path)
      return contents === undefined ? undefined : ts.createSourceFile(path, contents, languageVersion, true)
    } catch {
      onError?.('Pinned source file could not be read.')
      return undefined
    }
  }
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    if (name === 'effect' || name.startsWith('effect/') || name.startsWith('@effect/')) {
      return ts.resolveModuleName(name, resolve(tools, 'source-entry.ts'), options, host).resolvedModule
    }
    const importer = sourcePath(containingFile)
    if (name.startsWith('t3-source:') || name.startsWith('@t3tools/')
      || name.startsWith('@nessie/t3-session-source/contracts') || importer !== undefined) {
      const selected = resolver.resolve(name, importer)
      if (selected.kind === 'source') return { resolvedFileName: `${virtualRoot}${selected.path}`, isExternalLibraryImport: false }
      return ts.resolveModuleName(name, resolve(tools, 'source-entry.ts'), options, host).resolvedModule
    }
    return ts.resolveModuleName(name, containingFile, options, host).resolvedModule
  })
  const declarations = declarationDirectory
    ? declarationWriter({ virtualRoot, executorRoot: resolve(tools, '../..'), resolver, sharedContracts,
      resolveModule: (specifier, source) => ts.resolveModuleName(specifier, source, options, host)
        .resolvedModule?.resolvedFileName }) : undefined
  if (declarations) host.writeFile = declarations.writeFile
  const resolveEntry = path => path.startsWith('t3-source:')
    ? `${virtualRoot}${resolver.resolve(path).path}` : resolve(path)
  const entries = { index: resolveEntry(entryPoint), ...Object.fromEntries(Object.entries(additionalEntries)
    .map(([name, path]) => [name, resolveEntry(path)])) }
  let program = ts.createProgram(Object.values(entries), options, host)
  const authoredInputs = Object.fromEntries(program.getSourceFiles()
    .filter(source => sourcePath(source.fileName) === undefined && !slash(source.fileName).includes('/node_modules/'))
    .map(source => [slash(relative(resolve(tools, '../..'), source.fileName)),
      createHash('sha256').update(source.text).digest('hex')]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  // Erased imports and authored declarations are inputs before emit or bundler tree shaking.
  assertAuthoredInputs?.(Object.keys(authoredInputs))
  const check = () => {
    const diagnostics = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
    // Plain diagnostics keep generated type annotations out of diagnostic excerpts.
    if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, {
      getCurrentDirectory: () => tools, getCanonicalFileName: name => name, getNewLine: () => '\n',
    }))
  }
  check()
  const named = nameContractTypes(ts, program, sourcePath)
  if (named.sources.size) {
    // Check invariant equality against original inference before adding annotations.
    // Neither these assertions nor the annotations enter the runtime source snapshot.
    contractSources = named.checks
    program = ts.createProgram(Object.values(entries), options, host, program)
    check()
    contractSources = named.sources
    program = ts.createProgram(Object.values(entries), options, host, program)
    check()
  }
  if (declarations) {
    const emitDiagnostics = []
    for (const source of program.getSourceFiles()) {
      // JSON is checked input data. TypeScript emits no declaration for it;
      // consumers use the declarations inferred from the importing TS module.
      if (!source.isDeclarationFile && !ts.isJsonSourceFile(source)
        && !slash(source.fileName).includes('/node_modules/')) {
        const result = program.emit(source, declarations.writeFile, undefined, true)
        if (result.emitSkipped && !result.diagnostics.length) {
          throw new Error(`Session declaration emit was skipped: ${source.fileName}`)
        }
        emitDiagnostics.push(...result.diagnostics)
      }
    }
    if (emitDiagnostics.length) throw new Error(ts.formatDiagnostics(emitDiagnostics, {
      getCurrentDirectory: () => tools, getCanonicalFileName: name => name, getNewLine: () => '\n',
    }))
  }
  return { compiler: ts.version, sourceFiles: program.getSourceFiles().length, libraryChecks: true,
    authoredInputs, contractNaming: named.records,
    ...(declarations ? { declarations: await declarations.save(declarationDirectory, entries) } : {}) }
}
