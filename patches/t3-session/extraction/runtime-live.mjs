import { selectedImports } from './author.mjs'

const orchestration = 'apps/server/src/orchestration-v2/'

/** Select original live operations without importing their application owners. */
export const extractRuntimeLive = (author, redirects) => {
  for (const [name, guard] of [
    ['ProviderTurnControlService', 'isProviderTurnControlError'],
    ['RuntimeRequestService', 'isRuntimeRequestResponseExecutionError'],
  ]) {
    const file = `${orchestration}${name}.ts`
    const port = redirects.get(file)
    author.replace(port, `\nconst ${guard}`, `\nexport const ${guard}`, `runtime-error-guard:${name}`)
    const original = author.read(file)
    const body = original.slice(original.indexOf('export const layer:'))
    const prefix = name === 'ProviderTurnControlService'
      ? author.between(file, 'const yieldToRuntime =', 'import { ProviderTurnControlError,') : ''
    const target = `${orchestration}${name}.session-live.ts`
    author.derive(target, [
      selectedImports(original, prefix + body, file, target, redirects),
      `import { ${guard} } from "./${name}.session-port.ts";\n`,
      ...(prefix ? [author.sourcePart(file, prefix, { current: true })] : []),
      author.sourcePart(file, body, { current: true }),
    ], `runtime-live:${name}`)
  }

  // Resolving an existing extracted-text sidecar must not import the parser's
  // direct process launcher, executable discovery or full application entry.
  const document = 'apps/server/src/provider/DocumentText.ts'
  const documentTarget = 'apps/server/src/provider/DocumentText.session-path.ts'
  const extensions = author.between(document, 'const extensions =', 'class DocumentTextError')
  const resolver = author.between(document, 'export const resolveExtractedTextPath =', 'export class DocumentText')
  author.derive(documentTarget, [selectedImports(author.read(document), extensions + resolver,
    document, documentTarget), author.sourcePart(document, extensions), author.sourcePart(document, resolver)],
  'runtime-document-sidecar-resolution')

  const background = 'apps/server/src/background/BackgroundPolicy.ts'
  const backgroundTarget = `${orchestration}SessionBackgroundPolicy.ts`
  const backgroundPort = author.between(background, 'export class BackgroundPolicy extends', 'const DEFAULT_LEASE_TTL_MS')
  author.derive(backgroundTarget, [selectedImports(author.read(background), backgroundPort, background, backgroundTarget),
    author.sourcePart(background, backgroundPort)], 'runtime-background-policy-port')
  author.replace(background, backgroundPort,
    'import { BackgroundPolicy } from "../orchestration-v2/SessionBackgroundPolicy.ts";\nexport { BackgroundPolicy };\n\n',
    'runtime-share-background-policy')

  const cleanup = `${orchestration}ResourceCleanupService.ts`
  const cleanupTarget = `${orchestration}ResourceCleanupService.session-live.ts`
  const targets = `${orchestration}SessionResourceTargets.ts`
  author.add(targets, `import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
/** Actual resource owners; completion must include native lifetime clearance where applicable. */
export class SessionResourceTargets extends Context.Service<SessionResourceTargets, {
  readonly terminals: { readonly close: (input: { readonly threadId: string; readonly deleteHistory: true }) =>
    Effect.Effect<void, unknown> };
  readonly previews: { readonly close: (input: { readonly threadId: ThreadId }) => Effect.Effect<void, unknown> };
  readonly scheduledTasks: { readonly deleteForThread: (threadId: ThreadId) => Effect.Effect<void, unknown> };
}>()("nessie/session-engine/SessionResourceTargets") {}
`, 'runtime-resource-targets')
  const cleanupBody = author.read(cleanup).slice(author.read(cleanup).indexOf('export const layer ='))
  author.derive(cleanupTarget, [selectedImports(author.read(cleanup), cleanupBody, cleanup, cleanupTarget, redirects),
    author.sourcePart(cleanup, cleanupBody, { current: true })], 'runtime-resource-cleanup')
  for (const [module, service, member] of [
    ['TerminalManager', 'TerminalManager', 'terminals'],
    ['PreviewManager', 'PreviewManager', 'previews'],
    ['ScheduledTaskService', 'ScheduledTaskService', 'scheduledTasks'],
  ]) {
    // Remove only these application-owner imports; the original cleanup body,
    // file resolution, concurrency and error conversion remain selected source.
    const statement = author.read(cleanupTarget).match(new RegExp(`import \\* as ${module} from "[^"]+";\\n`, 'u'))[0]
    author.replace(cleanupTarget, statement, '', `runtime-resource-owner-import:${module}`)
    author.replace(cleanupTarget, `const ${member} = yield* ${module}.${service};`,
      `const ${member} = (yield* SessionResourceTargets).${member};`, `runtime-resource-owner:${module}`)
  }
  const first = author.read(cleanupTarget).match(/^import[^;]+;/u)[0]
  author.replace(cleanupTarget, first, `import { SessionResourceTargets } from "./SessionResourceTargets.ts";\n${first}`,
    'runtime-resource-owner-tag')
}
