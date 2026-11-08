import { selectedImports } from './author.mjs'

/** Original instance registry and session manager, with telemetry decorators
 * excluded at source. Lifecycle, idle/reuse locks, event queues, session IDs,
 * MCP registration and cleanup are original code, not a reduced native driver. */
export const extractProviderLive = (author, redirects) => {
  const sessions = 'apps/server/src/orchestration-v2/ProviderSessionManager.ts'
  const metrics = author.between(sessions, '        const turnMetrics =', '        return {\n          ...runtime,')
  author.replace(sessions, metrics, '', 'session-manager-exclude-metric-decorator')
  for (const [id, from, to] of [
    ['start', 'runtime.startTurn(input).pipe(turnMetrics("send", input.modelSelection.model))', 'runtime.startTurn(input)'],
    ['steer', 'runtime.steerTurn(input).pipe(turnMetrics("steer"))', 'runtime.steerTurn(input)'],
    ['interrupt', '                  turnMetrics("interrupt"),\n', ''],
    ['response', 'runtime\n                  .respondToRuntimeRequest(input)\n                  .pipe(turnMetrics("runtime-request-response"))',
      'runtime.respondToRuntimeRequest(input)'],
  ]) author.replace(sessions, from, to, `session-manager-exclude-${id}-metric`)
  for (const [id, from] of [
    ['release', `withMetrics({
                    counter: providerSessionsTotal,
                    attributes: {
                      provider: entry.runtime.driver,
                      operation: "release",
                      reason: input.reason,
                    },
                  }),`],
    ['open', `withMetrics({
                    counter: providerSessionsTotal,
                    attributes: { provider: adapter.driver, operation: "open" },
                  }),`],
  ]) author.replace(sessions, from, '', `session-manager-exclude-${id}-metric`)

  for (const file of [sessions, 'apps/server/src/provider/ProviderInstanceRegistry.ts']) {
    const original = author.read(file)
    const target = file.replace('.ts', '.session-live.ts')
    const fragments = original.split(/^import[\s\S]*?from "[^"]+"(?: with \{[^}]+\})?;/gm)
      .filter(part => part.trim())
    const body = fragments.join('')
    author.derive(target, [selectedImports(original, body, file, target, redirects),
      ...fragments.map(part => author.sourcePart(file, part, { current: true }))],
    `original-provider-live:${file}`)
  }

  const finalization = 'apps/server/src/orchestration-v2/RunFinalizationService.ts'
  const target = finalization.replace('.ts', '.session-live.ts')
  const original = author.read(finalization)
  // The original observer is supplied separately by actual workspace owners.
  // Do not select an application composition or the former no-op reference.
  const body = author.between(finalization, 'const make =', 'export const layerObserver')
  author.derive(target, [selectedImports(original, body, finalization, target, redirects),
    author.sourcePart(finalization, body, { current: true })], 'original-finalization-live')
}
