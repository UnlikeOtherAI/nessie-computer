import { exportedNames, selectedImports } from './author.mjs'

const root = 'apps/server/src/'
// Only declaration boundaries move. The application's live implementation remains in its original module.
const definitions = [
  ['config.ts', 'export const RuntimeMode =', 'export const make =', '  static readonly layerTest ='],
  ['serverSettings.ts', 'export class ServerSettingsService extends', 'const makeTest =', '  static readonly layerTest ='],
  ['environment/ServerEnvironment.ts', 'export class ServerEnvironment extends', 'function platformOs('],
  ['provider/ProviderInstanceRegistry.ts', 'export class ProviderInstanceRegistry extends', 'interface InstanceSecrets'],
  ['provider/ProviderRegistry.ts', 'export type ProviderMaintenanceActionKind =', 'const loadProviders ='],
  ['project/ProjectService.ts', 'export interface ProjectCreateInput extends', 'export const make ='],
  ['project/ProjectEnrichmentService.ts', 'export interface ProjectEnrichment {', 'function availableValue'],
  ['project/ManagedProjectFolders.ts', 'export class ScratchUnavailableError extends', 'const folderWords ='],
  ['project/ProjectSetupScriptRunner.ts', 'export interface ProjectSetupScriptRunnerResultNoScript', '/** @public */\n// Random per-run'],
  ['git/GitWorkflowService.ts', 'export class GitWorkflowService extends', 'function nonRepositoryLocalStatus'],
  ['git/GitManager.ts', 'export interface GitActionProgressReporter', 'const COMMIT_TIMEOUT_MS ='],
  ['sourceControl/SourceControlProviderRegistry.ts', 'export interface SourceControlProviderRegistration',
    'function unsupportedProvider('],
  ['policy/ManagedPolicy.ts', 'export class ManagedPolicy extends', 'type LimitsSummary ='],
  ['vcs/GitVcsDriver.ts', 'export interface ExecuteGitInput', 'const WORKSPACE_FILES_MAX_OUTPUT_BYTES ='],
  ['project/ProjectCloneTracker.ts', 'export class ProjectCloneTracker extends', 'const DONE_RETENTION ='],
  ['textGeneration/TextGeneration.ts', 'export class TextGeneration extends', 'type TextGenerationOp ='],
  ['mcp/McpSessionRegistry.ts', 'export interface McpCredentialRequest', 'interface CredentialRecord'],
  ['terminal/Manager.ts', 'export class TerminalManager extends', 'interface TerminalSubprocessInspectResult'],
  ['orchestration-v2/ProviderSessionManager.ts', 'export const PROVIDER_INTERRUPT_TIMEOUT_MS =', 'export interface ProviderSessionManagerV2LayerOptions'],
  ['orchestration-v2/CheckpointService.ts', 'export class CheckpointRootScopePrepareError extends',
    'export const checkpointRefForScopeOrdinal ='],
  ['orchestration-v2/ProviderTurnStartService.ts', 'export class ProviderTurnStartError extends', 'export const layer:'],
  ['orchestration-v2/ProviderTurnControlService.ts', 'export class ProviderTurnControlError extends', 'export const layer:'],
  ['orchestration-v2/RuntimeRequestService.ts', 'export class RuntimeRequestResponseExecutionError extends', 'export const layer:'],
  ['orchestration-v2/ThreadTitleRegenerationService.ts', 'export class ThreadTitleRegenerationService extends', 'const make ='],
  ['orchestration-v2/CheckpointRollbackService.ts', 'export const ROLLBACK_FAILED_MESSAGE =', 'export const layer:'],
  ['orchestration-v2/RunFinalizationService.ts', 'export class RunFinalizationError extends', 'const make ='],
  ['orchestration-v2/ResourceCleanupService.ts', 'export class ResourceCleanupError extends', 'export const layer ='],
  ['secrets/SecretRequests.ts', 'export class SecretRequests extends', 'const make ='],
]

export const extractHostPorts = author => {
  const redirects = new Map(definitions.map(([file]) => [root + file, root + file.replace('.ts', '.session-port.ts')]))
  const exports = new Map()
  for (const [relative, start, end, staticStart] of definitions) {
    const file = root + relative
    const original = author.read(file)
    const originalBody = author.between(file, start, end)
    let body = originalBody
    if (staticStart) body = body.slice(0, body.indexOf(staticStart)) + '}\n\n'
    const target = redirects.get(file)
    const prefix = selectedImports(original, body, file, target, redirects)
    const names = exportedNames(body)
    const values = new Set([...body.matchAll(/^export (?:class|const|function) (\w+)/gm)].map(match => match[1]))
    if (relative === 'orchestration-v2/CheckpointService.ts') {
      names.push('isCheckpointRestoreError')
      values.add('isCheckpointRestoreError')
    }
    const imports = names.map(name => `${values.has(name) ? '' : 'type '}${name}`).join(', ')
    const forwards = `import { ${imports} } from "./${target.split('/').at(-1)}";\nexport { ${imports} };\n\n`
    author.derive(target, [prefix, author.sourcePart(file, staticStart
      ? originalBody.slice(0, originalBody.indexOf(staticStart)) : originalBody), ...(staticStart ? ['}\n\n'] : [])],
    `extract-port:${relative}`)
    if (relative === 'orchestration-v2/CheckpointService.ts') {
      author.replace(target, 'const isCheckpointRestoreError =', 'export const isCheckpointRestoreError =',
        'share-checkpoint-error-guard')
    }
    author.replace(file, originalBody, forwards, `share-port:${relative}`)
    exports.set(file, new Set(names))
  }
  return { redirects, exports }
}
