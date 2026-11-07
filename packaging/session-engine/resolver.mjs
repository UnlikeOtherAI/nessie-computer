import { builtinModules } from 'node:module'
import { isAbsolute, posix, resolve } from 'node:path'

import { SessionEngineSourceError } from './source.mjs'

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
const contractAliases = new Map([
  ['@nessie/t3-session-source/contracts', 'packages/contracts/src/index.ts'],
  ['@nessie/t3-session-source/contracts/settings', 'packages/contracts/src/settings.ts'],
  ['@nessie/t3-session-source/contracts/relay', 'packages/contracts/src/relay.ts'],
])
const refuse = code => { throw new SessionEngineSourceError(code) }
const target = value => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  for (const condition of ['node', 'import', 'default']) {
    if (Object.hasOwn(value, condition)) {
      const selected = target(value[condition])
      if (selected) return selected
    }
  }
  return undefined
}

/** Resolve the actual upstream exports; never import a source checkout or a global T3. */
export const createSessionEngineSourceResolver = snapshot => {
  const files = new Set(snapshot.files)
  const packages = new Map()
  for (const file of snapshot.files.filter(file => /^packages\/[^/]+\/package.json$/u.test(file))) {
    const manifest = JSON.parse(snapshot.read(file).toString('utf8'))
    if (typeof manifest.name !== 'string' || packages.has(manifest.name)) refuse('SESSION_ENGINE_SOURCE_PACKAGE_INVALID')
    packages.set(manifest.name, { root: posix.dirname(file), exports: manifest.exports })
  }
  const source = path => {
    if (!files.has(path)) refuse('SESSION_ENGINE_SOURCE_FILE_ABSENT')
    const extension = posix.extname(path)
    if (!['.ts', '.tsx', '.json', '.mjs', '.js'].includes(extension)) refuse('SESSION_ENGINE_SOURCE_KIND_REFUSED')
    return { kind: 'source', path, loader: extension === '.json' ? 'json' : extension === '.tsx' ? 'tsx' : 'ts' }
  }
  return Object.freeze({
    resolve: (specifier, importer) => {
      if (builtins.has(specifier)) return { kind: 'builtin', path: specifier }
      if (contractAliases.has(specifier)) return source(contractAliases.get(specifier))
      if (specifier.startsWith('t3-source:')) return source(specifier.slice('t3-source:'.length))
      if (specifier.startsWith('.')) {
        if (!importer || !files.has(importer)) refuse('SESSION_ENGINE_SOURCE_IMPORTER_REFUSED')
        return source(posix.normalize(posix.join(posix.dirname(importer), specifier)))
      }
      if (!specifier.startsWith('@t3tools/') && !specifier.startsWith('effect-')) {
        return { kind: 'dependency', path: specifier }
      }
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      const entry = packages.get(name)
      if (!entry) refuse('SESSION_ENGINE_SOURCE_PACKAGE_ABSENT')
      const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`
      let exported = target(entry.exports?.[subpath])
      if (!exported && subpath !== '.') {
        const pattern = Object.keys(entry.exports ?? {}).filter(key => key.includes('*'))
          .sort((left, right) => right.indexOf('*') - left.indexOf('*'))
          .find(key => subpath.startsWith(key.split('*')[0]) && subpath.endsWith(key.split('*')[1]))
        if (pattern) {
          const [prefix, suffix] = pattern.split('*')
          const matched = subpath.slice(prefix.length, suffix.length === 0 ? undefined : -suffix.length)
          exported = target(entry.exports[pattern])?.replaceAll('*', matched)
        }
      }
      if (!exported?.startsWith('./')) refuse('SESSION_ENGINE_SOURCE_EXPORT_REFUSED')
      const resolved = posix.normalize(posix.join(entry.root, exported))
      if (!resolved.startsWith(`${entry.root}/`)) refuse('SESSION_ENGINE_SOURCE_EXPORT_REFUSED')
      return source(resolved)
    },
    load: path => snapshot.read(path),
  })
}

/** esbuild is injected by the build tool; the resolver itself needs only Node. */
export const sessionEngineSourcePlugin = ({ snapshot, dependencyDirectory, dependencies }) => {
  if (typeof dependencyDirectory !== 'string' || !isAbsolute(dependencyDirectory)) {
    refuse('SESSION_ENGINE_DEPENDENCY_DIRECTORY_REQUIRED')
  }
  const resolver = createSessionEngineSourceResolver(snapshot)
  const admitted = new Set(dependencies)
  const namespace = 'nessie-t3-source'
  return {
    name: 'nessie-pinned-session-engine-source',
    setup(build) {
      const resolveSource = async args => {
        const selected = resolver.resolve(args.path, args.namespace === namespace ? args.importer : undefined)
        if (selected.kind === 'builtin') return { path: selected.path, external: true }
        if (selected.kind === 'source') return { path: selected.path, namespace,
          pluginData: { ...args.pluginData, ...selected } }
        const name = selected.path.startsWith('@')
          ? selected.path.split('/').slice(0, 2).join('/') : selected.path.split('/')[0]
        if (!admitted.has(name)) refuse('SESSION_ENGINE_RUNTIME_DEPENDENCY_NOT_ADMITTED')
        return build.resolve(selected.path, { kind: args.kind, resolveDir: dependencyDirectory,
          namespace: 'file', pluginData: args.pluginData })
      }
      build.onResolve({ filter: /^t3-source:/ }, resolveSource)
      build.onResolve({ filter: /^@t3tools\// }, resolveSource)
      build.onResolve({ filter: /^@nessie\/t3-session-source\/contracts(?:\/(?:settings|relay))?$/ }, resolveSource)
      build.onResolve({ filter: /^effect-/ }, resolveSource)
      // Authored contract and engine entries resolve the same Effect instance as upstream source.
      build.onResolve({ filter: /^(?:effect(?:\/|$)|@effect\/)/, namespace: 'file' }, async args => {
        const selectedRoot = resolve(dependencyDirectory)
        if (args.pluginData?.nessieSharedEffectRoot && args.pluginData.nessieSharedEffectRoot !== selectedRoot) {
          refuse('SESSION_ENGINE_EFFECT_DEPENDENCY_ROOT_MISMATCH')
        }
        // T01's alias plugin uses the same flag, so composing the two hooks cannot recurse.
        if (args.pluginData?.nessieSharedEffect === true) return undefined
        const name = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : 'effect'
        if (!admitted.has(name)) refuse('SESSION_ENGINE_RUNTIME_DEPENDENCY_NOT_ADMITTED')
        return build.resolve(args.path, { kind: args.kind, resolveDir: dependencyDirectory,
          namespace: 'file', pluginData: { ...args.pluginData,
            nessieSharedEffect: true, nessieSharedEffectRoot: selectedRoot } })
      })
      build.onResolve({ filter: /.*/, namespace }, resolveSource)
      build.onLoad({ filter: /.*/, namespace }, args => ({
        contents: resolver.load(args.path), loader: args.pluginData.loader,
      }))
    },
  }
}
