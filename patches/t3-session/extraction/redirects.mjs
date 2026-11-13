import { posix } from 'node:path'
import { createSessionEngineSourceResolver } from '../../../packaging/session-engine/resolver.mjs'

const roots = [
  'Orchestrator', 'ThreadManagementLive', 'ThreadLaunchService', 'EffectWorker', 'ProviderRuntimeRecoveryService',
  'ProviderContinuationService', 'ThreadMessageIntake', 'ThreadSearch', 'ThreadFind', 'ThreadStream',
].map(name => `apps/server/src/orchestration-v2/${name}.ts`)

const bindings = (statement, text) => {
  const clause = statement.slice('import '.length, statement.lastIndexOf(' from ')).replace(/^type /u, '')
  const namespace = /^\* as (\w+)$/u.exec(clause)
  if (namespace) return [...text.replace(/^import[\s\S]*?from "[^"]+";/gm, '')
    .matchAll(new RegExp(`\\b${namespace[1]}\\.(\\w+)`, 'gu'))].map(match => match[1])
  if (!clause.startsWith('{')) return []
  return clause.slice(1, clause.lastIndexOf('}')).split(',').map(name => name.trim()).filter(Boolean)
    .map(name => name.replace(/^type /u, '').split(/\s+as\s+/u)[0])
}

/** An app consumer of a live factory stays on the live module; tag-only consumers use its shared declaration. */
export const redirectPortImports = (author, snapshot, redirects, exports) => {
  const resolver = createSessionEngineSourceResolver({ ...snapshot,
    files: [...new Set([...snapshot.files, ...author.files.keys()])], read: file => Buffer.from(author.read(file)) })
  const pending = [...roots, ...author.files.keys()].filter(file => file !== 'apps/server/src/ws.ts'
    && (!redirects.has(file) || roots.includes(file)))
  pending.push('apps/server/src/persistence/Sqlite.ts')
  const visited = new Set()
  while (pending.length) {
    const file = pending.pop()
    if (visited.has(file) || !file.endsWith('.ts')) continue
    visited.add(file)
    const text = author.read(file)
    const imports = [...text.matchAll(/^import[\s\S]*?from "([^"]+)";/gm)]
    for (const match of imports) {
      const specifier = match[1]
      if (!specifier.startsWith('.')) continue
      const originalPath = posix.normalize(posix.join(posix.dirname(file), specifier))
      const target = redirects.get(originalPath)
      const names = exports.get(originalPath)
      if (!target || !names || bindings(match[0], text).some(name => !names.has(name))) continue
      let relative = posix.relative(posix.dirname(file), target)
      if (!relative.startsWith('.')) relative = `./${relative}`
      author.replace(file, match[0], match[0].replace(`from "${specifier}"`, `from "${relative}"`),
        `port-import:${file}:${originalPath}`)
    }
    for (const match of author.read(file).matchAll(/^(?:import|export)[^;]*?from "([^"]+)";/gm)) {
      const resolved = resolver.resolve(match[1], file)
      if (resolved.kind === 'source') pending.push(resolved.path)
    }
  }
}
