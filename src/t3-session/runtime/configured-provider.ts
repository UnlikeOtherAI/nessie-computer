import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { ClaudeSettings, CodexSettings, ServerSettings, resolveProviderInstanceEnabled,
  resolveProjectProviderInstanceEnabled, type ProjectId, type ProviderInstanceId, type ServerSettingsError,
} from '@nessie/t3-session-source/contracts'
import { Settings } from '@nessie/t3-session-source/engine'

export class ConfiguredSessionProviderRefused extends Error {
  constructor() { super('T3_CONFIGURED_PROVIDER_REFUSED'); this.name = 'ConfiguredSessionProviderRefused' }
}
export interface ConfiguredSessionProvider {
  readonly instanceId: ProviderInstanceId
  readonly driverKind: 'codex' | 'claudeAgent'
  readonly settingsBytes: string
}
export type ConfiguredSessionProviderEffect = Effect.Effect<ConfiguredSessionProvider,
  ConfiguredSessionProviderRefused | ServerSettingsError, Settings.ServerSettingsReadService>

/** Reads the held original settings service, without constructing a driver,
 * resolving a secret or probing a provider. This selection grants no effects.
 * Protected resource binding separately verifies the actual configured homes.
 */
export const readConfiguredSessionProvider = (projectId: ProjectId,
  instanceId: ProviderInstanceId): ConfiguredSessionProviderEffect =>
  Effect.gen(function* () {
    const settings = yield* (yield* Settings.ServerSettingsReadService).getSettings
    const entry = Object.hasOwn(settings.providerInstances, instanceId)
      ? settings.providerInstances[instanceId] : undefined
    if (!entry || !resolveProviderInstanceEnabled(entry)
      || !resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)) {
      return yield* Effect.fail(new ConfiguredSessionProviderRefused())
    }
    if (entry.driver !== 'codex' && entry.driver !== 'claudeAgent') {
      return yield* Effect.fail(new ConfiguredSessionProviderRefused())
    }
    // These are the exact configSchema/defaultConfig codecs used by the pinned
    // original CodexDriver and ClaudeDriver. No driver factory is evaluated.
    const config = entry.driver === 'codex'
      ? yield* Schema.decodeUnknownEffect(CodexSettings)(entry.config ?? {}).pipe(
        Effect.mapError(() => new ConfiguredSessionProviderRefused()))
      : yield* Schema.decodeUnknownEffect(ClaudeSettings)(entry.config ?? {}).pipe(
        Effect.mapError(() => new ConfiguredSessionProviderRefused()))
    if (!config.enabled) return yield* Effect.fail(new ConfiguredSessionProviderRefused())
    return {
      instanceId, driverKind: entry.driver === 'codex' ? 'codex' as const : 'claudeAgent' as const,
      // Retained only in the enclosing runtime's opaque selection. This value
      // contains configuration and must never be emitted in a graph receipt.
      settingsBytes: canonicalExecutorJson(Schema.encodeSync(ServerSettings)(settings)),
    }
  })
