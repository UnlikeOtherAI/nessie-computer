/** Share the original adapter lookup and credential-change guards over its
 * exact execution projection. Full product registries remain valid callers. */
export const extractAdapterRegistry = author => {
  const file = 'apps/server/src/orchestration-v2/ProviderAdapterRegistry.ts'
  const original = author.between(file, 'export const layerFromProviderInstanceRegistry:', 'function makeRegistry(')
  const first = original.indexOf('    return ProviderAdapterRegistryV2.of({')
  const last = original.lastIndexOf('  }),\n);')
  if (first < 0 || last < first) throw new Error('Original adapter registry constructor changed')
  const implementation = original.slice(first, last)
  const shared = `export interface ProviderExecutionDirectory {
  readonly getInstance: (instanceId: ProviderInstanceId) => Effect.Effect<ProviderExecutionInstance | undefined>;
  readonly listInstances: Effect.Effect<ReadonlyArray<ProviderExecutionInstance>>;
}

export const fromProviderExecutionDirectory = (instances: ProviderExecutionDirectory):
  ProviderAdapterRegistryV2Shape => {
${implementation}};

export const layerFromProviderInstanceRegistry: Layer.Layer<
  ProviderAdapterRegistryV2, never, ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(ProviderAdapterRegistryV2,
  Effect.map(ProviderInstanceRegistry.ProviderInstanceRegistry, fromProviderExecutionDirectory));

`
  author.replace(file, original, shared, 'adapter-registry-shared-execution-projection')
  author.replace(file, 'import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";',
    `import type { ProviderExecutionInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";`,
    'adapter-registry-original-execution-type')
}
