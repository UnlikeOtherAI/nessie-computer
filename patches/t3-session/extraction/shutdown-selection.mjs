import { selectedImports } from './author.mjs'

/** Reuse the actual original pure selection before the fixture/native observer
 * compares it. Neither the extracted selector nor its exports perform effects. */
export const extractShutdownSelection = (author, redirects) => {
  const file = 'apps/server/src/orchestration-v2/RestartContinuation.ts'
  const target = file.replace('RestartContinuation.ts', 'ShutdownSelection.ts')
  const body = author.between(file, 'function restartContinuationBlocked(', 'export const continueRestartedRun =')
  author.derive(target, [selectedImports(author.read(file), body, file, target, redirects),
    author.sourcePart(file, body, { current: true })], 'shutdown-original-pure-selection')
  author.replace(file, body, 'import { restartContinuationRun, restartContinuationBlocked } from "./ShutdownSelection.ts";\n'
    + 'export { restartContinuationRun };\n\n', 'shutdown-share-original-selector')
  author.replace(target, 'function restartContinuationBlocked(', 'export function restartContinuationBlocked(',
    'shutdown-share-original-blocker')
  for (const name of ['latestProviderTurnForAttempt', 'awaitingProviderThreadId', 'cancelledRosterTaskWork',
    'cancelledTurnItemWork', 'isAwaitedWork', 'neverStarted']) {
    author.replace(file, `  ${name},\n`, '', `shutdown-move-selector-import:${name}`)
  }
  author.replace(file, 'import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";\n', '',
    'shutdown-move-projection-input-type')
}
