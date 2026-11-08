import { selectedImports } from './author.mjs'

/** One original entry and the original registry view, without reconciliation,
 * cache warming or a resolver. Resolved data is internal construction input,
 * never an authority token or an exported runtime secret getter. */
export const extractSelectedProvider = (author, redirects) => {
  const file = 'apps/server/src/provider/ProviderInstanceRegistry.ts'
  const target = 'apps/server/src/provider/SelectedProviderInstance.ts'
  author.replace(file, 'const buildEntry = Effect.fn("ProviderInstanceRegistry.buildEntry")(function* <R>(input: {',
    'const buildEntry = Effect.fn("ProviderInstanceRegistry.buildEntry")(function* <R, S>(input: {',
    'entry-separate-read-service-type')
  author.replace(file, '  readonly deferSecrets: boolean;\n}', `  readonly deferSecrets: boolean;
  readonly readSecrets: (driver: AnyProviderDriver<R>, entry: ProviderInstanceConfig) =>
    Effect.Effect<{ readonly secrets: InstanceSecrets; readonly unreadable: ReadonlyArray<string> }, never, S>;
}`, 'entry-explicit-read-boundary')
  author.replace(file, '  R | SecretResolver.SecretResolver\n> {', '  R | S\n> {', 'entry-read-service-requirement')
  author.replace(file, '? yield* readInstanceSecrets(driver, entry)',
    '? yield* input.readSecrets(driver, entry)', 'entry-use-explicit-reader')
  author.replace(file, '          deferSecrets,\n        });',
    '          deferSecrets,\n          readSecrets: readInstanceSecrets,\n        });', 'registry-retain-original-reader')

  // Move the existing view, not a second hand-written registry implementation.
  const view = author.between(file, '  const registry: ProviderInstanceRegistry["Service"] = {',
    '  const mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape = {')
  const viewFunction = `const registryView = ({ entries, unavailable, changes }: RegistryState):
  ProviderInstanceRegistry["Service"] => {
${view}  return registry;
};

`
  author.replace(file, view, '  const registry = registryView(state);\n\n', 'registry-shared-view-call')
  const marker = 'const entryEqual ='
  author.replace(file, marker, viewFunction + marker, 'registry-shared-view-definition')

  const declarations = author.between(file, 'interface InstanceSecrets', 'const entryEqual =')
  const secretHelpers = author.between(file, 'const secretReferencesIn =', 'const readInstanceSecrets =')
  const build = author.between(file, '/** Conflicting saved flags', 'const makeReconcile =')
  // isEntryEnabled belongs to global reconciliation; selected construction uses
  // the same decode/enable checks inside buildEntry itself.
  const enabledProbe = author.between(file, '// The enabled state `buildEntry`', 'const buildEntry =')
  const selectedBuild = build.replace(enabledProbe, '')
  const factory = `
/** A fixed selected instance; no mutator, refresh, prefetch or secret resolver. */
export const makeSelectedProviderInstance = Effect.fn("ProviderInstanceRegistry.makeSelected")(
  function* <R>(input: {
    readonly driver: AnyProviderDriver<R>;
    readonly instanceId: ProviderInstanceId;
    readonly entry: ProviderInstanceConfig;
    readonly secrets: InstanceSecrets;
  }): Effect.fn.Return<ProviderInstanceRegistry["Service"], never, R | Scope.Scope> {
    const parentScope = yield* Scope.Scope;
    const changes = yield* PubSub.unbounded<void>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
    const state: RegistryState = {
      entries: yield* Ref.make<ReadonlyMap<ProviderInstanceId, LiveEntry>>(new Map()),
      unavailable: yield* Ref.make<ReadonlyMap<ProviderInstanceId, ServerProvider>>(new Map()),
      secretsUnreadable: yield* Ref.make<ReadonlyMap<ProviderInstanceId, ProviderInstanceConfig>>(new Map()),
      changes,
    };
    const result = yield* buildEntry({
      driversById: new Map([[input.driver.driverKind, input.driver]]),
      blockedReason: () => undefined, parentScope, instanceId: input.instanceId,
      rawInstanceId: input.instanceId, entry: input.entry, deferSecrets: false,
      readSecrets: () => Effect.succeed({ secrets: input.secrets, unreadable: [] }),
    });
    if (result.kind === "live") yield* Ref.set(state.entries, new Map([[input.instanceId, result.live]]));
    else yield* Ref.set(state.unavailable, new Map([[input.instanceId, result.snapshot]]));
    // Escaped views cannot return a retired provider after the owning scope closes.
    yield* Effect.addFinalizer(() => Ref.set(state.entries, new Map()));
    return registryView(state);
  },
);
`
  const body = declarations + secretHelpers + selectedBuild + factory
  author.derive(target, [selectedImports(author.read(file), body, file, target, redirects),
    author.sourcePart(file, declarations, { current: true }),
    author.sourcePart(file, secretHelpers, { current: true }),
    ...build.split(enabledProbe).map(part => author.sourcePart(file, part, { current: true })), factory],
  'selected-original-provider-construction')
}
