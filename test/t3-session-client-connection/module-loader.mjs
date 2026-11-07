import { createRequire, stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SourceTextModule, SyntheticModule } from 'node:vm'

import { createSessionEngineSourceResolver } from '../../packaging/session-engine/resolver.mjs'

/** Full pinned modules, C02 resolution, and one explicitly owned Effect 4.1.2 singleton. */
export const createSourceModuleLoader = (snapshot, { dependencyDirectory, stubs = {}, env = {} }) => {
  const require = createRequire(pathToFileURL(resolve(dependencyDirectory, 'package.json')))
  const effectManifest = JSON.parse(readFileSync(require.resolve('effect/package.json')))
  if (effectManifest.version !== '4.1.2') throw new Error('PINNED_EFFECT_VERSION_REQUIRED')
  const resolver = createSessionEngineSourceResolver(snapshot)
  const cache = new Map()
  const synthetic = (name, values) => new SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value)
  }, { identifier: name })
  const get = async (specifier, importer) => {
    if (Object.hasOwn(stubs, specifier)) {
      if (!cache.has(specifier)) cache.set(specifier, synthetic(specifier, stubs[specifier]))
      return cache.get(specifier)
    }
    const selected = resolver.resolve(specifier, importer)
    const key = selected.path
    if (cache.has(key)) return cache.get(key)
    if (selected.kind !== 'source') {
      if (selected.kind !== 'dependency' || !key.startsWith('effect/')) {
        throw new Error(`UNSCHEDULED_DEPENDENCY_REFUSED:${key}`)
      }
      const namespace = await import(pathToFileURL(require.resolve(key)).href)
      const result = synthetic(key, namespace)
      cache.set(key, result)
      return result
    }
    const source = stripTypeScriptTypes(resolver.load(key).toString(), { sourceUrl: key })
    const result = new SourceTextModule(source, {
      identifier: key,
      initializeImportMeta: meta => { meta.env = env },
    })
    cache.set(key, result)
    return result
  }
  return {
    external: specifier => import(pathToFileURL(require.resolve(specifier)).href),
    load: async path => {
      const module = await get(`t3-source:${path}`)
      if (module.status === 'unlinked') await module.link((specifier, importer) => get(specifier, importer.identifier))
      if (module.status === 'linked') await module.evaluate()
      return module.namespace
    },
  }
}
