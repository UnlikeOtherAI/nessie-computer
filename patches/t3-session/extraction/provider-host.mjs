/** Replace the raw credential storage seam, preserving the original host tag. */
export const extractProviderHost = author => {
  const host = 'packages/provider-core/src/server/ProviderHost.ts'
  author.replace(host, 'import type * as Option from "effect/Option";\n', '', 'host-no-credential-bytes-option')
  author.replace(host, 'import type { ProviderCredentialError } from "./errors.ts";',
    'import * as Schema from "effect/Schema";', 'host-reference-error-import')
  const credentials = author.between(host, 'export interface ProviderCredentials {', 'export class ProviderHost extends')
  author.replace(host, credentials, `/** An opaque native association reference. It grants no execution or credential access. */
export interface ProviderCredentialReference {
  readonly binding: { readonly owner: "provider"; readonly key: string };
}

export class ProviderCredentialReferenceError extends Schema.TaggedError<ProviderCredentialReferenceError>()(
  "ProviderCredentialReferenceError", { reason: Schema.Literal("unavailable") },
) {}

/** Supplied by native custody. Resolution cannot return tokens, homes or credential bytes. */
export class ProviderCredentialReferences extends Context.Service<ProviderCredentialReferences, {
  readonly resolve: (namespace: string, bindingId: string) =>
    Effect.Effect<ProviderCredentialReference, ProviderCredentialReferenceError>;
}>()("nessie/session-engine/ProviderCredentialReferences") {}

`, 'host-opaque-credential-reference')
  author.replace(host, '    readonly credentials: (\n', '    readonly credentialReference: (\n',
    'host-reference-operation')
  author.replace(host, ') => Effect.Effect<ProviderCredentials>;',
    ') => Effect.Effect<ProviderCredentialReference, ProviderCredentialReferenceError>;',
    'host-reference-result')
}
