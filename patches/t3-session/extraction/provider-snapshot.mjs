import { selectedImports } from './author.mjs'

/** Share the original projection without importing executable status probes. */
export const extractProviderSnapshot = author => {
  const file = 'packages/provider-core/src/server/snapshotProbe.ts'
  const target = 'packages/provider-core/src/server/ServerProviderProjection.ts'
  const types = author.between(file, 'export interface ProviderProbeResult', 'export function nonEmptyTrimmed')
  const signature = author.between(file, 'export function buildServerProvider(input: {',
    '  const versionAdvisory = input.driver')
  const input = signature.slice('export function buildServerProvider(input: '.length,
    signature.indexOf('): ServerProviderDraft'))
  const result = author.between(file, '  return {\n    displayName: input.presentation.displayName,',
    'export const collectStreamAsString')
  const namedInput = `export type ServerProviderBuildInput = ${input};\n\n`
  const projection = `export function buildServerProviderProjection(input: ServerProviderBuildInput,
  versionAdvisory: ServerProviderVersionAdvisory | undefined): ServerProviderDraft {
`
  author.derive(target, [`import type { ServerProviderVersionAdvisory } from "@t3tools/contracts";\n`,
    selectedImports(author.read(file), types + input + result, file, target),
    author.sourcePart(file, types), namedInput, projection, author.sourcePart(file, result)],
  'provider-original-snapshot-projection')
  author.replace(file, types, `import { buildServerProviderProjection, type ServerProviderBuildInput,
  type ProviderProbeResult, type ServerProviderPresentation, type ServerProviderDraft }
  from "./ServerProviderProjection.ts";
export type { ProviderProbeResult, ServerProviderPresentation, ServerProviderDraft };

`, 'provider-share-snapshot-types')
  author.replace(file, signature,
    'export function buildServerProvider(input: ServerProviderBuildInput): ServerProviderDraft {\n',
    'provider-name-snapshot-input')
  author.replace(file, result, '  return buildServerProviderProjection(input, versionAdvisory);\n}\n\n',
    'provider-share-snapshot-projection')
  const unavailable = 'apps/server/src/provider/unavailableProviderSnapshot.ts'
  author.replace(unavailable,
    'import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";',
    'import { buildServerProviderProjection } from "../../../../packages/provider-core/src/server/ServerProviderProjection.ts";',
    'unavailable-provider-pure-projection')
  author.replace(unavailable, '  const { setup: _setup, ...base } = buildServerProvider({',
    '  const { setup: _setup, ...base } = buildServerProviderProjection({', 'unavailable-original-projection-call')
  // The original call supplies no driver, so its version advisory is absent.
  author.replace(unavailable, '    },\n  });\n\n  return {',
    '    },\n  }, undefined);\n\n  return {', 'unavailable-no-version-probe')
}
