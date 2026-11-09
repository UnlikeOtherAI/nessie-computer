import { selectedImports } from './author.mjs'

/** Extract the actual adapter behind its existing client factory. No server
 * spawner, maintenance, managed account or shadow-home materializer is bound. */
export const extractCodexHost = (author, redirects) => {
  const file = 'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts'
  const port = file.replace('.ts', '.session-port.ts')
  const tag = author.between(file, 'export interface CodexAppServerClientFactoryShape', '/** MCP startup grace')
  author.derive(port, [selectedImports(author.read(file), tag, file, port, redirects),
    author.sourcePart(file, tag)], 'codex-original-client-factory-port')
  author.replace(file, tag, `import { CodexAppServerClientFactory,
  type CodexAppServerClientFactoryShape } from "./CodexAdapterV2.session-port.ts";
export { CodexAppServerClientFactory, type CodexAppServerClientFactoryShape };

`, 'codex-share-client-factory-tag')

  const provider = 'apps/server/src/provider/CodexProvider.ts'
  const pure = 'apps/server/src/provider/CodexProtocolIdentity.ts'
  const identity = author.between(provider, 'export const codexAppServerEnvironment =', 'const codexProcessEnvironment =')
  const effort = author.between(provider, 'export function codexDefaultReasoningEffortOverride',
    'export function mapCodexModelCapabilities')
  const name = 'const CODEX_CLIENT_NAME = "T3 Code";\n'
  author.derive(pure, [selectedImports(author.read(provider), identity + effort, provider, pure),
    author.sourcePart(provider, name), author.sourcePart(provider, identity), author.sourcePart(provider, effort)],
  'codex-share-protocol-identity')
  author.replace(provider, identity, `import { codexAppServerEnvironment, buildCodexInitializeParams,
  codexDefaultReasoningEffortOverride } from "./CodexProtocolIdentity.ts";
export { codexAppServerEnvironment, buildCodexInitializeParams, codexDefaultReasoningEffortOverride };

`, 'codex-provider-shared-identity')
  author.replace(provider, effort, '', 'codex-provider-shared-effort')

  const home = 'apps/server/src/provider/Drivers/CodexHomeLayout.ts'
  const homePure = 'apps/server/src/provider/CodexHomeLayout.session-pure.ts'
  const shape = author.between(home, 'export interface CodexHomeLayout', 'const KNOWN_SHARED_DIRECTORIES')
  const resolve = author.between(home, 'function resolveHomePath', 'const CodexShadowHomeContext')
  const continuation = author.read(home).slice(author.read(home).indexOf('export function codexContinuationIdentity'))
  author.derive(homePure, [selectedImports(author.read(home), shape + resolve + continuation, home, homePure),
    author.sourcePart(home, shape), author.sourcePart(home, resolve), author.sourcePart(home, continuation)],
  'codex-original-home-selection')
  author.replace(home, shape, `import { resolveCodexHomeLayout, codexContinuationIdentity,
  type CodexHomeLayout } from "../CodexHomeLayout.session-pure.ts";
export { resolveCodexHomeLayout, codexContinuationIdentity, type CodexHomeLayout };

`, 'codex-share-home-selection')
  author.replace(home, resolve, '', 'codex-remove-home-selection-copy')
  author.replace(home, continuation, '', 'codex-remove-continuation-copy')

  const target = file.replace('.ts', '.session-live.ts')
  author.replace(file, '  adapterOptions: CodexAdapterV2Options,\n) {',
    `  adapterOptions: CodexAdapterV2Options,
): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2["Service"], never, McpProviderSessions.McpProviderSessions> {`,
    'codex-explicit-original-adapter-result')
  const raw = author.between(file, 'export const makeCodexAppServerSpawnCommand =', 'export type CodexAdapterV2DriverEnv =')
  const creation = author.between(file, 'export type CodexAdapterV2DriverEnv =', 'export interface CodexAdapterV2Options')
  const fragments = author.read(file).split(raw).flatMap(part => part.split(creation))
    .flatMap(part => part.split(/^import[\s\S]*?from "[^"]+"(?: with \{[^}]+\})?;/gm))
    .filter(part => part.trim())
  const body = fragments.join('')
  const paths = new Map(redirects).set(provider, pure)
  paths.set('apps/server/src/provider/DocumentText.ts',
    'apps/server/src/provider/DocumentText.session-path.ts')
  // Only this structural constant is used by the execution adapter. Port
  // discovery and raw process construction remain in the application host.
  const scanner = 'apps/server/src/preview/PortScanner.ts'
  const scannerPure = 'apps/server/src/provider/ProviderThreadEnvironment.ts'
  const threadEnv = 'export const AGENT_THREAD_ENV = "T3CODE_THREAD_ID";\n'
  author.derive(scannerPure, [author.sourcePart(scanner, threadEnv)], 'codex-thread-environment-name')
  author.replace(scanner, threadEnv, `import { AGENT_THREAD_ENV } from "../provider/ProviderThreadEnvironment.ts";
export { AGENT_THREAD_ENV };
`, 'codex-share-thread-environment-name')
  paths.set(scanner, scannerPure)
  author.derive(target, [selectedImports(author.read(file), body, file, target, paths),
    ...fragments.map(part => author.sourcePart(file, part, { current: true }))], 'codex-original-execution-adapter')
  // The managed-runtime shape is data only. Keep its implementation outside the
  // selected adapter declaration graph as well as its runtime dependency graph.
  const managed = 'apps/server/src/provider/CodexManagedRuntime.ts'
  const managedShape = author.between(managed, 'export interface CodexEffectiveRuntime', 'const decodeSettings =')
  const managedPort = 'apps/server/src/provider/CodexEffectiveRuntime.ts'
  author.derive(managedPort, [selectedImports(author.read(managed), managedShape, managed, managedPort),
    author.sourcePart(managed, managedShape)], 'codex-managed-runtime-data-shape')
  author.replace(target, 'from "../../provider/CodexManagedRuntime.ts"',
    'from "../../provider/CodexEffectiveRuntime.ts"', 'codex-no-managed-runtime-import')

  const driver = 'apps/server/src/provider/Drivers/CodexDriver.ts'
  const instance = 'apps/server/src/provider/CodexInstance.ts'
  const originalReturn = author.between(driver, '    return {\n      instanceId,\n      driverKind: DRIVER_KIND,',
    '    } satisfies ProviderInstance;') + '    } satisfies ProviderInstance;'
  const sharedReturn = originalReturn.replace('      snapshotForCwd,\n', '').replace('      consumeResetCredit,\n', '')
  author.add(instance, `import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderDriverKind } from "@t3tools/contracts";
const DRIVER_KIND = ProviderDriverKind.make("codex");
export const makeCodexInstance = ({ instanceId, continuationIdentity, displayName, accentColor,
  enabled, snapshot, orchestrationAdapter, textGeneration }: Pick<ProviderInstance,
  "instanceId" | "continuationIdentity" | "displayName" | "accentColor" | "enabled" |
  "snapshot" | "orchestrationAdapter" | "textGeneration">): ProviderInstance => {
${sharedReturn}
};
`, 'codex-shared-instance-assembly')
  author.replace(driver, originalReturn, `    return {
      ...makeCodexInstance({ instanceId, continuationIdentity, displayName, accentColor,
        enabled, snapshot, orchestrationAdapter, textGeneration }),
      snapshotForCwd, consumeResetCredit,
    } satisfies ProviderInstance;`, 'codex-use-shared-instance-assembly')
  author.replace(driver, 'const decodeCodexSettings =',
    'import { makeCodexInstance } from "../CodexInstance.ts";\nconst decodeCodexSettings =',
    'codex-import-instance-assembly')
  const selected = 'apps/server/src/provider/SelectedCodexDriver.ts'
  author.add(selected, `import { CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ProviderDriver, ProviderInstance, ProviderDriverCreateInput,
  ProviderExecutionDriver } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Continuations from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ServerConfig } from "../config.session-port.ts";
import { ServerSettingsService } from "../serverSettings.session-port.ts";
import * as ManagedProviders from "../policy/managedProviderSelection.ts";
import { CodexAppServerClientFactory } from "../orchestration-v2/Adapters/CodexAdapterV2.session-port.ts";
import { makeCodexAdapterV2, type CodexAdapterV2Options }
  from "../orchestration-v2/Adapters/CodexAdapterV2.session-live.ts";
import { resolveCodexHomeLayout, codexContinuationIdentity } from "./CodexHomeLayout.session-pure.ts";
import { makeCodexInstance } from "./CodexInstance.ts";

/** Real original services are required. There is no pending/ready stand-in,
 * refresh suppression or default text-generation implementation here. */
export class SelectedCodexServices extends Context.Service<SelectedCodexServices, {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly snapshot: ProviderInstance["snapshot"];
  readonly textGeneration: ProviderInstance["textGeneration"];
  readonly compatibility: NonNullable<CodexAdapterV2Options["compatibility"]>;
}>()("nessie/session-engine/SelectedCodexServices") {}

export type SelectedCodexExecutionEnv = CodexAppServerClientFactory |
  Digest.Digest | FileSystem.FileSystem | Path.Path | IdAllocator.IdAllocatorV2 |
  Continuations.ProviderContinuationRequests | McpProviderSessions.McpProviderSessions | ServerConfig |
  ServerSettingsService;
export type SelectedCodexDriverEnv = SelectedCodexServices | SelectedCodexExecutionEnv;

export type SelectedCodexExecutionHooks = Pick<SelectedCodexServices["Service"], "instanceId" | "compatibility"> & {
  readonly onUsageLimits?: NonNullable<CodexAdapterV2Options["onUsageLimits"]>;
};

const selectedCodexConfigurationError = (input: ProviderDriverCreateInput<CodexSettings>) =>
  input.config.setupMode === "managed" || input.config.shadowHomePath.trim() || !input.config.homePath.trim()
    ? new ProviderDriverError({ driver: ProviderDriverKind.make("codex"), instanceId: input.instanceId,
      detail: "Selected Codex home preparation is not admitted." }) : undefined;

const codexDefinition = {
  driverKind: ProviderDriverKind.make("codex"),
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  configSchema: CodexSettings,
  defaultConfig: () => Schema.decodeSync(CodexSettings)({}),
};

/** Actual original adapter construction. Product snapshots and text generation
 * retain their own hosts; no replacement implementation is supplied here. */
export const makeSelectedCodexExecutionDriver = (hooks: SelectedCodexExecutionHooks):
  ProviderExecutionDriver<CodexSettings, SelectedCodexExecutionEnv> => ({
  ...codexDefinition,
  create: Effect.fn("CodexDriver.createSelectedExecution")(function* (input) {
    // A saved overlay requires materializeCodexShadowHome: mkdir, symlink,
    // replacement and private-auth checks. Launch/reserve do not grant it.
    const invalid = selectedCodexConfigurationError(input);
    if (invalid) return yield* invalid;
    if (hooks.instanceId !== input.instanceId) return yield* new ProviderDriverError({
      driver: ProviderDriverKind.make("codex"), instanceId: input.instanceId,
      detail: "Selected Codex services belong to another instance.",
    });
    const settingsService = yield* ServerSettingsService;
    const hostEnvironment = ManagedProviders.providerHostEnvironment(
      settingsService.managedPolicy, yield* HostProcess.Environment);
    const environment = yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment);
    const homeLayout = yield* resolveCodexHomeLayout(input.config);
    const orchestrationAdapter = yield* makeCodexAdapterV2({
      instanceId: input.instanceId,
      settings: { ...input.config, enabled: input.enabled,
        binaryPath: expandHomePath(input.config.binaryPath, yield* HostProcess.HomeDirectory),
        homePath: homeLayout.effectiveHomePath ?? "" },
      environment, clientFactory: yield* CodexAppServerClientFactory,
      digest: yield* Digest.Digest, fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2, serverConfig: yield* ServerConfig,
      continuationRequests: yield* Continuations.ProviderContinuationRequests,
      ...(hooks.onUsageLimits ? { onUsageLimits: hooks.onUsageLimits } : {}), compatibility: hooks.compatibility,
    });
    return { instanceId: input.instanceId, driverKind: ProviderDriverKind.make("codex"), enabled: input.enabled,
      continuationIdentity: codexContinuationIdentity(homeLayout), orchestrationAdapter };
  }),
});

export const SelectedCodexDriver: ProviderDriver<CodexSettings, SelectedCodexDriverEnv> = {
  ...codexDefinition,
  create: Effect.fn("CodexDriver.createSelected")(function* (input) {
    const invalid = selectedCodexConfigurationError(input);
    if (invalid) return yield* invalid;
    const services = yield* SelectedCodexServices;
    const execution = yield* makeSelectedCodexExecutionDriver({ instanceId: services.instanceId,
      compatibility: services.compatibility, onUsageLimits: update => services.snapshot.applyUsageLimits(update) }).create(input);
    return makeCodexInstance({ ...input, ...execution, snapshot: services.snapshot,
      textGeneration: services.textGeneration });
  }),
};
`, 'codex-selected-original-driver')
}
