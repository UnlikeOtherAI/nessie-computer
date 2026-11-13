import { selectedImports } from './author.mjs'

/** The original adapter is shared before reuse. Application process/history
 * creation stays outside the selected closure; all real effect hosts remain
 * required, including attachment conversion's ChildProcessSpawner. */
export const extractClaudeHost = (author, redirects) => {
  const file = 'apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts'
  const target = file.replace('.ts', '.session-live.ts')
  author.replace(file, '  adapterOptions: ClaudeAdapterV2Options,\n) {',
    `  adapterOptions: ClaudeAdapterV2Options,
): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2["Service"], never,
  McpProviderSessions.McpProviderSessions | ChildProcessSpawner.ChildProcessSpawner> {`,
    'claude-explicit-original-adapter-result')
  const group = author.between(file, 'const CLAUDE_GROUP_WATCH_SCRIPT =', 'export const ClaudeProviderCapabilitiesV2')
  const close = author.between(file, 'function closeClaudeQuery(', 'const CLAUDE_MCP_APP_CAPABILITIES =')
  const logger = author.between(file, 'function makeClaudeAgentSdkProtocolLogger(', 'const encodeClaudeJson =')
  const workers = author.between(file, 'const decodeClaudeHistoryFork =', 'function canApplyClaudeSelectionLive(')
  const factory = author.read(file).slice(author.read(file).indexOf('export type ClaudeAdapterV2DriverEnv ='))
  const fragments = author.read(file).split(group).flatMap(part => part.split(close))
    .flatMap(part => part.split(logger)).flatMap(part => part.split(workers)).flatMap(part => part.split(factory))
    .flatMap(part => part.split(/^import[\s\S]*?from "[^"]+"(?: with \{[^}]+\})?;/gm))
    .filter(part => part.trim())
  const body = fragments.join('')
  const paths = new Map(redirects)
  for (const name of ['ClaudeSkillDispatch', 'ClaudeSkills', 'ClaudeHome']) {
    paths.set(`apps/server/src/provider/Drivers/${name}.ts`, `apps/server/src/provider/${name}.ts`)
  }
  // Move the configuration/skill library once, before either host reuses it.
  // The application paths reexport the same functions. Driver constructors and
  // maintenance stay excluded by the unchanged source-graph policy.
  for (const name of ['ClaudeSkillDispatch', 'ClaudeSkills', 'ClaudeHome']) {
    const source = `apps/server/src/provider/Drivers/${name}.ts`
    const shared = paths.get(source)
    const original = author.read(source)
    const parts = original.split(/^import[\s\S]*?from "[^"]+"(?: with \{[^}]+\})?;/gm)
      .filter(part => part.trim())
    author.derive(shared, [selectedImports(original, parts.join(''), source, shared, paths),
      ...parts.map(part => author.sourcePart(source, part, { current: true }))], `claude-shared-library:${name}`)
    author.replace(source, original, `export * from "../${name}.ts";\n`, `claude-application-shared-library:${name}`)
  }
  paths.set('apps/server/src/provider/DocumentText.ts', 'apps/server/src/provider/DocumentText.session-path.ts')
  paths.set('apps/server/src/preview/PortScanner.ts', 'apps/server/src/provider/ProviderThreadEnvironment.ts')
  author.derive(target, [selectedImports(author.read(file), body, file, target, paths),
    ...fragments.map(part => author.sourcePart(file, part, { current: true }))], 'claude-original-execution-adapter')

  const driver = 'apps/server/src/provider/Drivers/ClaudeDriver.ts'
  const instance = 'apps/server/src/provider/ClaudeInstance.ts'
  const originalReturn = author.between(driver, '    return {\n      instanceId,\n      driverKind: DRIVER_KIND,',
    '    } satisfies ProviderInstance;') + '    } satisfies ProviderInstance;'
  const common = originalReturn.slice(0, originalReturn.indexOf('      invalidateCaches:'))
    + '      orchestrationAdapter,\n      textGeneration,\n    } satisfies ProviderInstance;'
  author.add(instance, `import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderDriverKind } from "@t3tools/contracts";
const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
export const makeClaudeInstance = ({ instanceId, continuationIdentity, displayName, accentColor,
  enabled, snapshot, orchestrationAdapter, textGeneration }: Pick<ProviderInstance,
  "instanceId" | "continuationIdentity" | "displayName" | "accentColor" | "enabled" |
  "snapshot" | "orchestrationAdapter" | "textGeneration">): ProviderInstance => {
${common.replace(`      continuationIdentity: {
        ...fallbackContinuationIdentity,
        continuationKey: continuationGroupKey,
      },`, '      continuationIdentity,')}
};
`, 'claude-shared-instance-assembly')
  const extras = originalReturn.slice(originalReturn.indexOf('      invalidateCaches:'),
    originalReturn.lastIndexOf('      orchestrationAdapter,'))
  author.replace(driver, originalReturn, `    return {
      ...makeClaudeInstance({ instanceId,
        continuationIdentity: { ...fallbackContinuationIdentity, continuationKey: continuationGroupKey },
        displayName, accentColor, enabled, snapshot, orchestrationAdapter, textGeneration }),
${extras}      consumeResetCredit,
    } satisfies ProviderInstance;`, 'claude-use-shared-instance-assembly')
  author.replace(driver, 'const decodeClaudeSettings =',
    'import { makeClaudeInstance } from "../ClaudeInstance.ts";\nconst decodeClaudeSettings =',
    'claude-import-instance-assembly')

  const selected = 'apps/server/src/provider/SelectedClaudeDriver.ts'
  author.add(selected, `import { win32 } from "node:path";
import { ClaudeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ProviderDriver, ProviderInstance, ProviderDriverCreateInput,
  ProviderExecutionDriver } from "@t3tools/provider-core/server/driver";
import { defaultProviderContinuationIdentity } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Continuations from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ServerConfig } from "../config.session-port.ts";
import { ServerSettingsService } from "../serverSettings.session-port.ts";
import * as ManagedProviders from "../policy/managedProviderSelection.ts";
import { ClaudeAgentSdkQueryRunner } from "../orchestration-v2/Adapters/ClaudeAdapterV2.session-port.ts";
import { makeClaudeAdapterV2, type ClaudeAdapterV2Options }
  from "../orchestration-v2/Adapters/ClaudeAdapterV2.session-live.ts";
import { makeClaudeEnvironment, mergeClaudeProcessEnvironment, makeClaudeContinuationGroupKey }
  from "./ClaudeHome.ts";
import { makeClaudeInstance } from "./ClaudeInstance.ts";

/** These actual original services must be supplied by the admitted host. No
 * synthetic snapshot/catalog/text generator or application maintenance runs. */
export class SelectedClaudeServices extends Context.Service<SelectedClaudeServices, {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly snapshot: ProviderInstance["snapshot"];
  readonly textGeneration: ProviderInstance["textGeneration"];
  readonly modelCatalog: NonNullable<ClaudeAdapterV2Options["modelCatalog"]>;
  readonly scopedLimitNames: NonNullable<ClaudeAdapterV2Options["scopedLimitNames"]>;
}>()("nessie/session-engine/SelectedClaudeServices") {}

export type SelectedClaudeExecutionEnv = ClaudeAgentSdkQueryRunner |
  FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom | IdAllocator.IdAllocatorV2 |
  Continuations.ProviderContinuationRequests | McpProviderSessions.McpProviderSessions | ServerConfig |
  ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService;
export type SelectedClaudeDriverEnv = SelectedClaudeServices | SelectedClaudeExecutionEnv;

export type SelectedClaudeExecutionHooks = Pick<SelectedClaudeServices["Service"],
  "instanceId" | "modelCatalog" | "scopedLimitNames"> & {
  readonly onUsageLimits?: NonNullable<ClaudeAdapterV2Options["onUsageLimits"]>;
};

const selectedClaudeConfigurationError = (input: ProviderDriverCreateInput<ClaudeSettings>) =>
  !win32.isAbsolute(input.config.binaryPath)
    || win32.extname(input.config.binaryPath).toLowerCase() !== ".exe" || !input.config.homePath.trim()
    ? new ProviderDriverError({ driver: ProviderDriverKind.make("claudeAgent"), instanceId: input.instanceId,
      detail: "Selected Claude launch resolution is not admitted." }) : undefined;

const claudeDefinition = {
  driverKind: ProviderDriverKind.make("claudeAgent"),
  metadata: { displayName: "Claude", supportsMultipleInstances: true },
  configSchema: ClaudeSettings,
  defaultConfig: () => Schema.decodeSync(ClaudeSettings)({}),
};

/** Actual original adapter with the execution projection of its instance. */
export const makeSelectedClaudeExecutionDriver = (hooks: SelectedClaudeExecutionHooks):
  ProviderExecutionDriver<ClaudeSettings, SelectedClaudeExecutionEnv> => ({
  ...claudeDefinition,
  create: Effect.fn("ClaudeDriver.createSelectedExecution")(function* (input) {
    // The service pins the actual explicit image and home at preparation. PATH,
    // launch scripts and default homes have no admitted resolution here.
    const invalid = selectedClaudeConfigurationError(input);
    if (invalid) return yield* invalid;
    if (hooks.instanceId !== input.instanceId) return yield* new ProviderDriverError({
      driver: ProviderDriverKind.make("claudeAgent"), instanceId: input.instanceId,
      detail: "Selected Claude services belong to another instance.",
    });
    const settings = yield* ServerSettingsService;
    const host = ManagedProviders.providerHostEnvironment(settings.managedPolicy, yield* HostProcess.Environment);
    // Preserve the original settings-env read and merge. FileSystem must be an
    // actual admitted owner; no replacement data or ambient Node layer is bound.
    const base = yield* mergeClaudeProcessEnvironment(input.config, input.environment, host);
    const environment = yield* makeClaudeEnvironment(input.config, base);
    const continuationKey = yield* makeClaudeContinuationGroupKey(input.config, environment);
    const orchestrationAdapter = yield* makeClaudeAdapterV2({
      instanceId: input.instanceId, settings: { ...input.config, enabled: input.enabled }, environment,
      attachmentsDir: (yield* ServerConfig).attachmentsDir,
      fileSystem: yield* FileSystem.FileSystem, path: yield* Path.Path,
      random: yield* SecureRandom.SecureRandom, idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: yield* ClaudeAgentSdkQueryRunner,
      continuationRequests: yield* Continuations.ProviderContinuationRequests,
      modelCatalog: hooks.modelCatalog, scopedLimitNames: hooks.scopedLimitNames,
      ...(hooks.onUsageLimits ? { onUsageLimits: hooks.onUsageLimits } : {}),
    });
    return { instanceId: input.instanceId, driverKind: ProviderDriverKind.make("claudeAgent"), enabled: input.enabled,
      continuationIdentity: { ...defaultProviderContinuationIdentity({
        driverKind: ProviderDriverKind.make("claudeAgent"), instanceId: input.instanceId }), continuationKey },
      orchestrationAdapter };
  }),
});

export const SelectedClaudeDriver: ProviderDriver<ClaudeSettings, SelectedClaudeDriverEnv> = {
  ...claudeDefinition,
  create: Effect.fn("ClaudeDriver.createSelected")(function* (input) {
    const invalid = selectedClaudeConfigurationError(input);
    if (invalid) return yield* invalid;
    const services = yield* SelectedClaudeServices;
    const execution = yield* makeSelectedClaudeExecutionDriver({ instanceId: services.instanceId,
      modelCatalog: services.modelCatalog, scopedLimitNames: services.scopedLimitNames,
      onUsageLimits: update => services.snapshot.applyUsageLimits(update) }).create(input);
    return makeClaudeInstance({ ...input, ...execution, snapshot: services.snapshot,
      textGeneration: services.textGeneration });
  }),
};
`, 'claude-selected-original-driver')
}
