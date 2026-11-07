import { exportedNames, selectedImports } from './author.mjs'

/** Separate the real service constructor from the application's optional no-op-importer composition. */
export const extractThreadLive = (author, redirects, exports) => {
  const file = 'apps/server/src/orchestration-v2/ThreadManagementService.ts'
  const target = file.replace('ThreadManagementService.ts', 'ThreadManagementLive.ts')
  const api = file.replace('.ts', '.session-api.ts')
  const commandTargets = author.between(file, 'function existingThreadIdsForCommand(', 'export function isActiveRun(')
  const methods = author.between(file, 'export function isActiveRun(', 'const layerLegacyV1ThreadImporterNoop =')
  const original = author.read(file)
  const layer = original.slice(original.indexOf('export const layerWithLegacyImporter:'))
  const prefix = selectedImports(original, commandTargets + methods + layer, file, target, redirects)
  author.derive(target, [prefix, 'export * from "./ThreadManagementService.session-api.ts";\n',
    author.sourcePart(file, commandTargets, { current: true }),
    author.sourcePart(file, methods, { current: true }), author.sourcePart(file, layer, { current: true })],
  'extract-real-thread-service')
  author.replace(target, 'const make = Effect.gen(', 'export const make = Effect.gen(', 'share-real-thread-factory')
  author.replace(file, commandTargets, '', 'move-thread-command-targets-to-live')
  const names = ['make', ...exportedNames(methods)]
  author.replace(file, methods,
    `import { ${names.join(', ')} } from "./ThreadManagementLive.ts";\nexport { ${names.join(', ')} };\n\n`,
    'app-reuses-real-thread-service')
  author.replace(file, layer, 'export { layerWithLegacyImporter } from "./ThreadManagementLive.ts";\n',
    'app-reexports-real-thread-layer')
  redirects.set(file, target)
  exports.set(file, new Set([...names, ...exportedNames(author.read(api)), 'layerWithLegacyImporter']))
}
