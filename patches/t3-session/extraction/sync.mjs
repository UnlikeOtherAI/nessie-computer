import { selectedImports } from './author.mjs'

export const extractSync = (author, redirects) => {
  const file = 'apps/server/src/ws.ts'
  const target = 'apps/server/src/sessionSync.ts'
  const original = author.read(file)
  const constants = author.between(file, 'const SHELL_RESUME_MAX_GAP =', 'function toAuthAccessStreamEvent(')
  const bounded = author.between(file, 'function shouldUseBoundedThreadSnapshot(', 'function readClientAnalyticsProps(')
  const operations = author.between(file, 'const canReplayPersistedRange =', 'export const layerWsRpc =')
  // The same operations accept the narrowed source read service. No fake mutation service is provided.
  const body = constants + bounded + operations
  const imports = selectedImports(original, body, file, target, redirects)
  const threadImport = imports.match(/^import \* as ThreadManagementService from "[^"]+";$/mu)?.[0]
  if (!threadImport) throw new Error('The source sync read-service import is missing.')
  const prefix = imports.replace(threadImport,
    'import * as ThreadManagementService from "./orchestration-v2/ThreadReadsTag.ts";')
  author.derive(target, [prefix, author.sourcePart(file, constants), author.sourcePart(file, bounded),
    author.sourcePart(file, operations)], 'extract-source-sync')
  // Preserve the original application's full-service requirement while the engine uses a read-only tag.
  const wrapper = name => `export const ${name} = (input: Parameters<typeof SessionSync.${name}>[0]) =>\n  Effect.flatMap(ThreadManagementService.ThreadManagementService, (threads) =>\n    SessionSync.${name}(input).pipe(Effect.provideService(ThreadReadsTag.ThreadManagementService, threads)));\n`
  author.replace(file, operations, 'import * as SessionSync from "./sessionSync.ts";\n'
    + 'import * as ThreadReadsTag from "./orchestration-v2/ThreadReadsTag.ts";\n'
    + wrapper('subscribeOrchestrationV2Thread') + wrapper('subscribeOrchestrationV2Shell') + '\n', 'share-source-sync')
  return target
}
