import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSessionEngineSourceResolver } from './resolver.mjs'
import { declarationWriter } from './declarations.mjs'

const tools = fileURLToPath(new URL('.', import.meta.url))
const slash = path => path.replaceAll('\\', '/')

/** Type-check the real source closure without writing upstream files into a checkout. */
export const typecheckSessionState = async (snapshot, entryPoint, { declarationDirectory } = {}) => {
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
  const diskRead = host.readFile.bind(host)
  const diskExists = host.fileExists.bind(host)
  const diskDirectoryExists = host.directoryExists?.bind(host)
  host.readFile = path => {
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
    ? declarationWriter({ virtualRoot, executorRoot: resolve(tools, '../..'), resolver }) : undefined
  if (declarations) host.writeFile = declarations.writeFile
  const program = ts.createProgram([resolve(entryPoint)], options, host)
  // Full upstream schema inference exceeds TS's declaration serializer. Check the complete graph;
  // emit authored declarations and retain verified upstream type source instead of widening schemas.
  const diagnostics = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
  if (diagnostics.length > 0) {
    // Paths refer only to committed code and public dependencies, never user state.
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => tools, getCanonicalFileName: name => name, getNewLine: () => '\n',
    }))
  }
  if (declarations) {
    for (const source of program.getSourceFiles()) {
      if (sourcePath(source.fileName) !== undefined) {
        declarations.addSourceTypes(source)
      } else if (!source.isDeclarationFile && !slash(source.fileName).includes('/node_modules/')) {
        const result = program.emit(source, declarations.writeFile, undefined, true)
        if (result.emitSkipped || result.diagnostics.length) throw new Error(ts.formatDiagnostics(result.diagnostics, {
          getCurrentDirectory: () => tools, getCanonicalFileName: name => name, getNewLine: () => '\n',
        }))
      }
    }
  }
  return { compiler: ts.version, sourceFiles: program.getSourceFiles().length, libraryChecks: true,
    ...(declarations ? { declarations: await declarations.save(declarationDirectory, resolve(entryPoint)) } : {}) }
}
