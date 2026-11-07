import { stripTypeScriptTypes } from 'node:module'
import { compileFunction } from 'node:vm'

import { createSessionEngineSourceResolver } from '../../packaging/session-engine/resolver.mjs'

/** Evaluate the complete dependency-free original shared module after patch verification. */
export const loadSharedBoundary = async snapshot => {
  const resolver = createSessionEngineSourceResolver(snapshot)
  const entry = resolver.resolve('@t3tools/shared/advertisedEndpoint')
  const source = stripTypeScriptTypes(resolver.load(entry.path).toString(), { sourceUrl: entry.path })
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

/**
 * Execute exact, uniquely bounded source functions without activating an app graph.
 * Bindings are explicit dependencies, never alternate URL implementations.
 * Real Effect/HTTP integration uses the full modules in the separate scheduled check.
 */
export const sourceFunctions = (snapshot, file, start, end, exports, bindings = {}) => {
  const contents = snapshot.read(file).toString()
  if (contents.split(start).length !== 2 || (end !== null && contents.split(end).length !== 2)) {
    throw new Error('SOURCE_FUNCTION_SEAM_NOT_UNIQUE')
  }
  const from = contents.indexOf(start)
  const until = end === null ? contents.length : contents.indexOf(end, from)
  if (until <= from) throw new Error('SOURCE_FUNCTION_SEAM_ORDER_INVALID')
  const source = stripTypeScriptTypes(contents.slice(from, until), { sourceUrl: file })
    .replaceAll('export function ', 'function ').replaceAll('export const ', 'const ')
  return compileFunction(`${source}\nreturn {${exports.join(',')}}`, Object.keys(bindings), {
    filename: file,
  })(...Object.values(bindings))
}
