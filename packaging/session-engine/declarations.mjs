import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, posix, relative, resolve } from 'node:path'
import { isBuiltin } from 'node:module'

const slash = text => text.replaceAll('\\', '/')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** Convert compiler-only virtual paths into a portable, ordinary declaration tree. */
export const declarationWriter = ({ virtualRoot, executorRoot, resolver, sharedContracts = false }) => {
  const files = new Map()
  const contractRoot = 'packages/contracts/src/'
  const sourceLocation = path => sharedContracts && path.startsWith(contractRoot)
    ? `../source/${path.slice(contractRoot.length)}` : `source/${path}`
  const location = file => {
    const normalized = slash(file)
    if (normalized.toLowerCase().startsWith(virtualRoot.toLowerCase())) {
      return sourceLocation(normalized.slice(virtualRoot.length).replace(/\.tsx?$/u, '.d.ts'))
    }
    const local = slash(relative(executorRoot, file))
    if (local.startsWith('../')) throw new Error('Declaration source lies outside the owned source closure.')
    return `authored/${local.replace(/\.tsx?$/u, '.d.ts')}`
  }
  const modulePath = (specifier, source, declaration) => {
    let target
    if (specifier.startsWith('t3-source:') || specifier.startsWith('@t3tools/') || specifier.startsWith('effect-')
      || specifier.startsWith('@nessie/t3-session-source/contracts')) {
      const resolved = resolver.resolve(specifier)
      if (resolved.kind !== 'source') throw new Error('Workspace declaration did not resolve to pinned source.')
      target = sourceLocation(resolved.path.replace(/\.tsx?$/u, '.js'))
    } else if (slash(specifier).toLowerCase().startsWith(virtualRoot.toLowerCase())) {
      target = location(specifier).replace(/\.d\.ts$/u, '.js')
    } else if (specifier.startsWith('.')) {
      const resolved = resolve(dirname(source), specifier)
      target = location(resolved).replace(/\.d\.ts$/u, '.js')
    } else {
      if (isBuiltin(specifier)) return specifier
      if (specifier.includes(':') || specifier.startsWith('/')) throw new Error('Absolute declaration import refused.')
      return specifier
    }
    const path = posix.relative(posix.dirname(declaration), target)
    return path.startsWith('.') ? path : `./${path}`
  }
  const portableModule = (source, text, path) => {
    const portable = text.replace(/((?:from\s+|import\()\s*["'])([^"']+)(["'])/gu,
      (_match, before, specifier, after) => `${before}${modulePath(specifier, source, path)}${after}`)
    if (portable.includes(slash(executorRoot)) || portable.includes(virtualRoot)) {
      throw new Error('Machine-specific declaration path refused.')
    }
    return portable
  }
  const writeDeclaration = (_path, text, _bom, _error, sources) => {
    if (sources?.length !== 1) throw new Error('Declaration provenance must identify exactly one source file.')
    const source = sources[0].fileName
    const path = location(source)
    files.set(path, portableModule(source, text, path))
  }
  const addSourceTypes = source => {
    const local = slash(source.fileName).slice(virtualRoot.length)
    if (sharedContracts && local.startsWith(contractRoot)) return
    const path = `source/${local}`
    files.set(path, portableModule(source.fileName, source.text, path))
  }
  const save = async (directory, entryPoint) => {
    const entry = location(entryPoint).replace(/\.d\.ts$/u, '.js')
    files.set('index.d.ts', `export * from './${entry}'\n`)
    const identities = {}
    for (const [path, content] of [...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      const destination = resolve(directory, path)
      await mkdir(dirname(destination), { recursive: true })
      const existing = await readFile(destination).catch(error => {
        if (error.code !== 'ENOENT') throw error
        return undefined
      })
      if (existing && hash(existing) !== hash(content)) throw new Error('Declaration output conflict.')
      if (!existing) await writeFile(destination, content, { flag: 'wx' })
      identities[path] = hash(content)
    }
    return { entry: 'index.d.ts', upstream: 'verified-type-source', files: identities,
      sha256: hash(JSON.stringify(identities)) }
  }
  return { writeFile: writeDeclaration, addSourceTypes, save }
}
