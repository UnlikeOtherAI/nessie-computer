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
  const prefix = selectedImports(original, body, file, target, redirects)
    .replace('import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.session-api.ts";',
      'import * as ThreadManagementService from "./orchestration-v2/ThreadReadsTag.ts";')
  author.derive(target, [prefix, author.sourcePart(file, constants), author.sourcePart(file, bounded),
    author.sourcePart(file, operations)], 'extract-source-sync')
  author.replace(file, operations,
    'export { subscribeOrchestrationV2Thread, subscribeOrchestrationV2Shell } from "./sessionSync.ts";\nimport { subscribeOrchestrationV2Thread, subscribeOrchestrationV2Shell } from "./sessionSync.ts";\n\n',
    'share-source-sync')
  return target
}
