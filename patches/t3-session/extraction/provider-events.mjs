/** Preserve original event normalization/commit/locking; omit only telemetry.
 * This changes the same source module used by the manager and run service, so
 * every consumer retains the original Context identity and event contract. */
export const extractProviderEvents = author => {
  const file = 'apps/server/src/orchestration-v2/ProviderEventIngestor.ts'
  author.replace(file, `import {
  ProviderTurnAnalytics,
  type ProviderTurnAnalyticsContext,
} from "../telemetry/ProviderUsageAnalytics.ts";
`, '', 'provider-events-exclude-analytics-import')
  author.replace(file, '  readonly analyticsContext?: ProviderTurnAnalyticsContext;\n', '',
    'provider-events-exclude-analytics-context')
  author.replace(file, '    const analytics = yield* ProviderTurnAnalytics;\n', '',
    'provider-events-exclude-analytics-owner')
  author.replace(file, '    const completedTurnAnalytics = new Set<string>();\n', '',
    'provider-events-exclude-analytics-cache')
  const start = `              Effect.tap((storedEvents) =>
                Effect.gen(function* () {
                  if (storedEvents.length === 0 || input.event.type !== "provider_turn.updated")`
  const end = '              (effect) =>\n                input.event.type === "app_thread.created"'
  author.replace(file, author.between(file, start, end), '', 'provider-events-exclude-completion-analytics')
  // Usage refresh is an excluded diagnostic effect. It must not construct a
  // product-wide provider directory or spawn an unadmitted probe on turn failure.
  const refresh = author.between(file, `              Effect.tap((storedEvents) =>
                Effect.gen(function* () {
                  if (
                    storedEvents.length === 0 ||
                    input.event.type !== "turn.terminal"`, `              Effect.flatMap((storedEvents) =>
                Effect.gen(function* () {
                  if (input.event.type !== "app_thread.created")`)
  author.replace(file, refresh, '', 'provider-events-exclude-usage-refresh')
  author.replace(file, 'import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";\n', '',
    'provider-events-no-diagnostic-directory-import')
  author.replace(file, '  | ProviderInstanceRegistry.ProviderInstanceRegistry\n', '',
    'provider-events-no-diagnostic-directory-requirement')
  author.replace(file, '    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;\n', '',
    'provider-events-no-diagnostic-directory-owner')
  author.replace(file, '    const scope = yield* Effect.scope;\n', '', 'provider-events-no-diagnostic-fiber-scope')
}
