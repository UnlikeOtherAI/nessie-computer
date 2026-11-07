// A final engine build imports contracts through the SAME source namespace as
// engine services, with one caller-selected dependency root and Effect instance.
import { isAbsolute } from 'node:path'
export { readSessionEngineSnapshot } from '../../packaging/session-engine/snapshot.mjs'
export { createSessionEngineSourceResolver, sessionEngineSourcePlugin } from '../../packaging/session-engine/resolver.mjs'
export const T3_CONTRACTS_SOURCE_ENTRY = 't3-source:packages/contracts/src/index.ts'
export const sessionContractsAliasPlugin = ({ dependencyDirectory }) => {
  if (typeof dependencyDirectory !== 'string' || !isAbsolute(dependencyDirectory)) {
    throw new Error('T3_SHARED_DEPENDENCY_ROOT_REQUIRED')
  }
  return {
  name: 'nessie-t3-contracts-shared-source',
  setup(build) {
    // First-party file modules and virtual original modules must resolve Effect
    // from this same root, even when the workspace has another installed copy.
    build.onResolve({ filter: /^effect(?:\/|$)/ }, args => {
      if (args.pluginData?.nessieSharedEffect === true) return undefined
      return build.resolve(args.path, { kind: args.kind, resolveDir: dependencyDirectory,
        namespace: 'file', pluginData: { nessieSharedEffect: true } })
    })
    build.onResolve({ filter: /^@nessie\/t3-session-source\/contracts(?:\/(?:settings|relay))?$/ }, args => {
      const subpath = args.path.split('/')[3]
      return build.resolve(subpath ? `t3-source:packages/contracts/src/${subpath}.ts` : T3_CONTRACTS_SOURCE_ENTRY,
        { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir })
    })
  },
  }
}
