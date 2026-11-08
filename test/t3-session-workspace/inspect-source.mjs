import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { applySessionEngineBoundaryPatches } from '../../packaging/session-engine/patches.mjs'
import { createSessionEngineSourceResolver } from '../../packaging/session-engine/resolver.mjs'
import { assertSessionEngineSourceGraph } from '../../packaging/session-engine/graph.mjs'
import { sourceSnapshot } from './source-fixture.mjs'

// Bounded, builtin syntax/import inspection; does not evaluate source or qualify the real compiler graph.
const snapshot = applySessionEngineBoundaryPatches(sourceSnapshot(),
  readFileSync(new URL('../../patches/t3-session/workspace/boundary-patches.json', import.meta.url)))
const resolver = createSessionEngineSourceResolver(snapshot)
const entry = readFileSync(new URL('../../patches/t3-session/workspace/Engine.ts', import.meta.url), 'utf8')
const pending = [...entry.matchAll(/from 't3-source:([^']+)'/gu)].map(match => match[1])
const files = new Set()
while (pending.length) {
  const file = pending.pop()
  if (files.has(file)) continue
  files.add(file)
  if (files.size > 200) throw new Error('WORKSPACE_STATIC_GRAPH_LIMIT')
  const runtime = stripTypeScriptTypes(snapshot.read(file).toString('utf8'), { mode: 'strip' })
  for (const match of runtime.matchAll(/(?:import|export)[^;]*?from "([^"]+)"/gu)) {
    const next = resolver.resolve(match[1], file)
    if (next.kind === 'source' && !next.path.startsWith('packages/contracts/')) pending.push(next.path)
  }
}
for (const file of files) {
  try { assertSessionEngineSourceGraph([file]) } catch (error) {
    process.stderr.write(`Refused workspace dependency: ${file}\n`)
    throw error
  }
}
process.stdout.write(`${files.size} workspace runtime source modules inspected; compiler and runtime unqualified\n`)
