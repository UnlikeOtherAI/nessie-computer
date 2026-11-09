/** Preserve the original entry validation and scope ownership for both the
 * full product instance and its orchestration-only projection. No full
 * snapshot/text-generation object is manufactured for an execution adapter. */
export const extractProviderConstruction = author => {
  const driver = 'packages/provider-core/src/server/driver.ts'
  author.replace(driver, 'export interface ProviderContinuationIdentity {',
    `/** The exact fields consumed by ProviderAdapterRegistry. */
export type ProviderExecutionInstance = Pick<ProviderInstance,
  "instanceId" | "driverKind" | "continuationIdentity" | "enabled" | "orchestrationAdapter" | "auth">;

export type ProviderExecutionDriver<Config, R = never> = Omit<ProviderDriver<Config, R>, "create"> & {
  readonly create: (input: ProviderDriverCreateInput<Config>) =>
    Effect.Effect<ProviderExecutionInstance, ProviderDriverError, R | Scope.Scope>;
};

export interface ProviderContinuationIdentity {`, 'provider-original-execution-projection')
  const file = 'apps/server/src/provider/ProviderInstanceRegistry.ts'
  author.replace(file, 'import type { AnyProviderDriver, ProviderInstance }',
    'import type { AnyProviderDriver, ProviderInstance, ProviderExecutionInstance }', 'registry-execution-projection-type')
  author.replace(file, 'interface LiveEntry {',
    `type ProviderConstructionDriver<R, A> = Omit<AnyProviderDriver<R>, "create"> & {
  readonly create: (input: Parameters<AnyProviderDriver<R>["create"]>[0]) =>
    Effect.Effect<A, import("@t3tools/provider-core/server/errors").ProviderDriverError, R | Scope.Scope>;
};
type ProviderRegistryView<A> = Omit<ProviderInstanceRegistry["Service"], "getInstance" | "listInstances"> & {
  readonly getInstance: (instanceId: ProviderInstanceId) => Effect.Effect<A | undefined>;
  readonly listInstances: Effect.Effect<ReadonlyArray<A>>;
};

interface LiveEntry<A = ProviderInstance> {`, 'registry-generic-construction-result')
  author.replace(file, '  readonly instance: ProviderInstance;', '  readonly instance: A;', 'registry-actual-instance-result')
  author.replace(file, 'interface RegistryState {', 'interface RegistryState<A = ProviderInstance> {',
    'registry-generic-view-state')
  author.replace(file, '  readonly entries: Ref.Ref<ReadonlyMap<ProviderInstanceId, LiveEntry>>;',
    '  readonly entries: Ref.Ref<ReadonlyMap<ProviderInstanceId, LiveEntry<A>>>;', 'registry-generic-view-entries')
  // These readers inspect only codecs. Their argument must not force the
  // unrelated full product constructor into an execution-only type closure.
  author.replace(file, 'const configSecretReferences = <R>(\n  driver: AnyProviderDriver<R> | undefined,',
    'const configSecretReferences = <R>(\n  driver: Pick<AnyProviderDriver<R>, "configSchema"> | undefined,',
    'registry-config-reader-projection')
  author.replace(file, 'const secretReferencesOf = <R>(\n  driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>,',
    'const secretReferencesOf = <R>(\n  driversById: ReadonlyMap<ProviderDriverKind, Pick<AnyProviderDriver<R>, "configSchema">>,',
    'registry-reference-reader-projection')
  const reader = author.between(file, 'const readInstanceSecrets =', '/** Conflicting saved flags')
  author.replace(file, reader, reader.replace('driver: AnyProviderDriver<R> | undefined,',
    'driver: Pick<AnyProviderDriver<R>, "configSchema"> | undefined,'), 'registry-secret-reader-projection')
  author.replace(file, 'function* <R, S>(input: {', 'function* <R, S, A = ProviderInstance>(input: {',
    'registry-generic-entry-constructor')
  const start = 'const buildEntry = Effect.fn("ProviderInstanceRegistry.buildEntry")'
  const body = author.between(file, start, 'const makeReconcile =')
  const next = body.replace('ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>',
    'ReadonlyMap<ProviderDriverKind, ProviderConstructionDriver<R, A>>')
    .replace('readonly live: LiveEntry }', 'readonly live: LiveEntry<A> }')
    .replace('readSecrets: (driver: AnyProviderDriver<R>,',
      'readSecrets: (driver: Pick<AnyProviderDriver<R>, "configSchema">,')
  author.replace(file, body, next, 'registry-share-validated-construction')
}
