import { SessionEngineSourceError } from './source.mjs'

const excluded = [
  /^apps\/server\/src\/(?:server\.ts|ws\.ts|bin[^/]*\.ts|auth\/|telemetry\/|preview\/|device\/)/u,
  /^apps\/server\/src\/provider\/(?:Drivers\/|ProviderHostLive\.ts|ProviderCredentialStore\.ts)/u,
  /^packages\/source-control-[^/]+\/src\/server\//u,
  /^apps\/server\/src\/(?:config|serverSettings|serverRuntime[^/]*)\.ts$/u,
  /^apps\/server\/src\/(?:orchestration-v2\/)?runtimeLayer\.ts$/u,
  /^apps\/server\/src\/orchestration-v2\/ThreadManagementService\.ts$/u,
  /^apps\/server\/src\/provider\/(?:builtInProviderCatalog|ProviderRegistry)\.ts$/u,
  /^apps\/server\/src\/(?:cloud\/|usage\/|observability\/exporters\/)/u,
  /^apps\/server\/src\/.*\/(?:ProviderUsageService|UsageService|UsageLimitsService)\.ts$/u,
]

export const assertSessionEngineSourceGraph = sourceInputs => {
  if (sourceInputs.some(input => excluded.some(pattern => pattern.test(input)))) {
    throw new SessionEngineSourceError('SESSION_ENGINE_AGGREGATE_REFUSED')
  }
}
