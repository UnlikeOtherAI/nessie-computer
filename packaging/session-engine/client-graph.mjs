import { posix } from 'node:path'

/** Inspect only outputs reachable from /client in the shared split build. */
export const assertBrowserClientGraph = metafile => {
  const outputs = new Map(Object.entries(metafile.outputs).map(([path, output]) =>
    [path.replaceAll('\\', '/'), output]))
  const entry = [...outputs].filter(([, output]) =>
    /(?:^|\/)core\/Client\.ts$/u.test(output.entryPoint?.replaceAll('\\', '/') ?? ''))
  if (entry.length !== 1) throw new Error('CLIENT_OUTPUT_ENTRY_MISSING')
  const visited = new Set()
  const inputs = new Set()
  const external = new Set()
  const visit = path => {
    if (visited.has(path)) return
    const output = outputs.get(path)
    if (!output) throw new Error(`CLIENT_OUTPUT_MISSING:${path}`)
    visited.add(path)
    for (const input of Object.keys(output.inputs)) {
      const normalized = input.replaceAll('\\', '/')
      if (normalized.startsWith('nessie-t3-source:')) {
        if (!/^nessie-t3-source:(?:packages\/|apps\/mobile\/src\/)/u.test(normalized)) {
          throw new Error(`CLIENT_SERVER_SOURCE_REFUSED:${normalized}`)
        }
      } else if (!/(?:^|\/)core\/Client\.ts$/u.test(normalized)) {
        throw new Error(`CLIENT_AUTHORED_OR_DEPENDENCY_INPUT_REFUSED:${normalized}`)
      }
      inputs.add(normalized)
    }
    for (const imported of output.imports) {
      if (imported.external) {
        if (!/^(?:effect|@noble\/hashes)(?:\/|$)/u.test(imported.path)) {
          throw new Error(`CLIENT_EXTERNAL_REFUSED:${imported.path}`)
        }
        external.add(imported.path)
      } else {
        const target = imported.path.replaceAll('\\', '/')
        visit(outputs.has(target) ? target : posix.normalize(posix.join(posix.dirname(path), target)))
      }
    }
  }
  visit(entry[0][0])
  return { outputs: [...visited].sort(), inputs: [...inputs].sort(), external: [...external].sort() }
}
