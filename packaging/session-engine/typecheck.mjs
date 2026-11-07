import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSessionEngineSourceResolver } from './resolver.mjs'

const tools = fileURLToPath(new URL('.', import.meta.url))
const slash = path => path.replaceAll('\\', '/')

/** Type-check the real source closure without writing upstream files into a checkout. */
export const typecheckSessionState = async (snapshot, entryPoint) => {
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
    noEmit: true, allowImportingTsExtensions: true, resolveJsonModule: true, verbatimModuleSyntax: true,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noImplicitOverride: true,
    skipLibCheck: true, allowSyntheticDefaultImports: true, esModuleInterop: true,
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
    const importer = sourcePath(containingFile)
    if (name.startsWith('t3-source:') || importer !== undefined) {
      const selected = resolver.resolve(name, importer)
      if (selected.kind === 'source') return { resolvedFileName: `${virtualRoot}${selected.path}`, isExternalLibraryImport: false }
      return ts.resolveModuleName(name, resolve(tools, 'source-entry.ts'), options, host).resolvedModule
    }
    return ts.resolveModuleName(name, containingFile, options, host).resolvedModule
  })
  const program = ts.createProgram([resolve(entryPoint)], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length > 0) {
    // Paths refer only to committed code and public dependencies, never user state.
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => tools, getCanonicalFileName: name => name, getNewLine: () => '\n',
    }))
  }
  return { compiler: ts.version, sourceFiles: program.getSourceFiles().length }
}
