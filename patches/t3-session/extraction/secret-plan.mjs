/** Share the original registry's ordered selection without constructing a
 * registry, driver or secret resolver. Reading this plan grants no secret use. */
export const extractProviderSecretPlan = author => {
  const file = 'apps/server/src/provider/ProviderInstanceRegistry.ts'
  const target = 'apps/server/src/provider/ProviderInstanceSecretPlan.ts'
  author.add(target, `import type { ProviderInstanceConfig, SecretReference, SettingsSecretSlot,
  ProviderInstanceEnvironment, ResolvedProviderInstanceEnvironment }
  from "@t3tools/contracts";
import { secretReferencesInSettings } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

export interface ProviderInstanceSecretPlan {
  readonly environment: ReadonlyArray<{ readonly index: number; readonly name: string;
    readonly reference: SecretReference }>;
  readonly config: ReadonlyArray<SettingsSecretSlot & { readonly reference: SecretReference }>;
  readonly references: ReadonlyArray<SecretReference>;
}

/** Exact environment order followed by the original codec's declared config slots. */
export const planProviderInstanceSecrets = (schema: Schema.Top | undefined,
  entry: ProviderInstanceConfig): ProviderInstanceSecretPlan => {
  const environment = (entry.environment ?? []).flatMap((variable, index) =>
    typeof variable.value === "string" ? [] : [{ index, name: variable.name, reference: variable.value }]);
  const config = schema === undefined ? [] : secretReferencesInSettings(schema, entry.config);
  return { environment, config,
    references: [...environment.map(slot => slot.reference), ...config.map(slot => slot.reference)] };
};

/** Original variable conversion. Pure data transformation, never read authority. */
export const resolveProviderEnvironmentVariable = (variable: ProviderInstanceEnvironment[number],
  secret: string | undefined): ResolvedProviderInstanceEnvironment[number] | undefined => {
  if (typeof variable.value === "string") return { ...variable, value: variable.value };
  if (secret === undefined || secret.trim() === "") return undefined;
  return { ...variable, value: secret, sensitive: true };
};
`, 'provider-original-secret-plan')
  const first = author.read(file).match(/^import[\s\S]*?;/u)[0]
  author.replace(file, first,
    `import { planProviderInstanceSecrets, resolveProviderEnvironmentVariable }
  from "./ProviderInstanceSecretPlan.ts";\n${first}`,
    'provider-use-original-secret-plan')
  const before = `  const configFields = configSecretReferences(driver, entry);
  const references = [
    ...secretReferencesIn(variables),
    ...configFields.map(({ reference }) => reference),
  ];`
  author.replace(file, before, `  const plan = planProviderInstanceSecrets(driver?.configSchema, entry);
  const configFields = plan.config;
  const references = plan.references;`, 'provider-secret-read-exact-plan')
  const variable = `    if (typeof variable.value === "string") return [{ ...variable, value: variable.value }];
    const secret = next();
    if (secret === undefined) {
      unreadable.push(variable.name);
      return [];
    }
    return [{ ...variable, value: secret, sensitive: true }];`
  author.replace(file, variable, `    const resolved = resolveProviderEnvironmentVariable(variable,
      typeof variable.value === "string" ? undefined : next());
    if (resolved === undefined) {
      unreadable.push(variable.name);
      return [];
    }
    return [resolved];`, 'provider-share-environment-slot-installation')
}
