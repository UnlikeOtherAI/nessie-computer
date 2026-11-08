import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as ProviderHost from 't3-source:packages/provider-core/src/server/ProviderHost.ts'
import * as Config from 't3-source:apps/server/src/config.session-port.ts'
import * as Settings from 't3-source:apps/server/src/serverSettings.session-port.ts'
import * as Background from 't3-source:apps/server/src/orchestration-v2/SessionBackgroundPolicy.ts'
import * as DocumentText from 't3-source:apps/server/src/provider/DocumentText.session-path.ts'
import { resolveAttachmentPath } from 't3-source:apps/server/src/attachmentStore.ts'

/**
 * Original ProviderHost behavior over executor-owned paths/settings and native
 * references. Resolving a reference is not admission. Each native effect still
 * consumes its signed operation through the protected custody transport.
 */
export const sessionProviderHostLayer = Layer.effect(ProviderHost.ProviderHost, Effect.gen(function* () {
  const config = yield* Config.ServerConfig
  const settings = yield* Settings.ServerSettingsService
  const background = yield* Background.BackgroundPolicy
  const references = yield* ProviderHost.ProviderCredentialReferences
  const fileSystem = yield* FileSystem.FileSystem
  return ProviderHost.ProviderHost.of({
    paths: {
      cwd: config.cwd,
      baseDir: config.baseDir,
      stateDir: config.stateDir,
      providerStatusCacheDir: config.providerStatusCacheDir,
      attachmentsDir: config.attachmentsDir,
    },
    settings: {
      get: settings.getSettings,
      withSnapshot: settings.withSettingsSnapshot,
      changes: settings.streamChanges,
      subscribe: settings.subscribeChanges,
    },
    shouldRunBackgroundWork: background.shouldRunScopeWork,
    resolveAttachmentPath: attachment => resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
    resolveExtractedTextPath: path => DocumentText.resolveExtractedTextPath(path).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem)),
    credentialReference: (namespace, bindingId) => references.resolve(namespace, bindingId),
  })
}))

export { Background as SessionBackground }
export { ProviderCredentialReferences, ProviderCredentialReferenceError }
  from 't3-source:packages/provider-core/src/server/ProviderHost.ts'
export type { ProviderCredentialReference } from 't3-source:packages/provider-core/src/server/ProviderHost.ts'
