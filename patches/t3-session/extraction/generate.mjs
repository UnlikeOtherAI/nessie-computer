import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readSessionEngineSnapshot } from '../../../packaging/session-engine/snapshot.mjs'
import { applySessionEngineBoundaryPatches } from '../../../packaging/session-engine/patches.mjs'
import { createPatchAuthor, selectedImports, exportedNames } from './author.mjs'
import { extractHostPorts } from './ports.mjs'
import { extractReadServices } from './reads.mjs'
import { extractSync } from './sync.mjs'
import { redirectPortImports } from './redirects.mjs'
import { extractThreadLive } from './thread-live.mjs'
import { extractRuntimeLive } from './runtime-live.mjs'
import { extractProviderHost } from './provider-host.mjs'
import { extractPrelaunch } from './prelaunch.mjs'
import { extractColdLaunch } from './cold-launch.mjs'
import { extractProviderLive } from './provider-live.mjs'
import { extractProviderEvents } from './provider-events.mjs'
import { extractInspectionHosts } from './inspection-hosts.mjs'
import { extractProviderSecretPlan } from './secret-plan.mjs'
import { extractSelectedProvider } from './selected-provider.mjs'
import { extractCodexHost } from './codex-host.mjs'
import { extractClaudeQuery } from './claude-query.mjs'
import { extractClaudeHost } from './claude-host.mjs'
import { extractCodexSerialization } from './serialization.mjs'
import { extractCommandLineage } from './command-lineage.mjs'
import { extractEffectCommand } from './effect-command.mjs'
import { extractEffectClaims } from './effect-claims.mjs'
import { extractLifecycleTransactions } from './lifecycle.mjs'
import { extractWorkerClaims } from './worker-claims.mjs'

/** Reproduce the reviewed exact source refactors from the original verified capsule. */
export const generateExtractionManifest = snapshot => {
  const author = createPatchAuthor(snapshot)
  const { redirects, exports } = extractHostPorts(author)
  const settingsPort = redirects.get('apps/server/src/serverSettings.ts')
  const settingsSuffix = author.read(settingsPort).slice(-100)
  author.replace(settingsPort, settingsSuffix,
    settingsSuffix + 'export { resolveReviewGuideModelSelection, resolveSourceControlWriterModelSelection } from "@t3tools/shared/serverSettings";\n',
    'settings-pure-model-selection')
  exports.get('apps/server/src/serverSettings.ts').add('resolveSourceControlWriterModelSelection')
  exports.get('apps/server/src/serverSettings.ts').add('resolveReviewGuideModelSelection')
  const clone = 'apps/server/src/project/ProjectCloneTracker.ts'
  const clonePort = redirects.get(clone)
  const cloneGuard = author.between(clone, 'export const rejectCommandsDuringClone =', 'function describeCloneFailure(')
  const cloneSuffix = author.read(clonePort).slice(-100)
  author.replace(clonePort, cloneSuffix, cloneSuffix + cloneGuard, 'clone-admission-pure-operation')
  author.replace(clone, cloneGuard,
    'import { rejectCommandsDuringClone } from "./ProjectCloneTracker.session-port.ts";\nexport { rejectCommandsDuringClone };\n\n',
    'share-clone-admission')
  exports.get(clone).add('rejectCommandsDuringClone')
  extractInspectionHosts(author, redirects)
  const reads = extractReadServices(author, redirects)
  extractThreadLive(author, redirects, exports)
  extractRuntimeLive(author, redirects)
  extractProviderHost(author)
  extractPrelaunch(author)
  extractColdLaunch(author, redirects, exports)
  extractCommandLineage(author)
  extractEffectCommand(author)
  extractEffectClaims(author)
  extractLifecycleTransactions(author)
  extractWorkerClaims(author)
  extractProviderSecretPlan(author)
  extractSelectedProvider(author, redirects)
  extractCodexHost(author, redirects)
  extractClaudeQuery(author, redirects)
  extractClaudeHost(author, redirects)
  extractProviderLive(author, redirects)
  extractProviderEvents(author)
  extractCodexSerialization(author)
  for (const [relative, symbols] of [
    ['Orchestrator', [['const', 'isOrchestratorProjectionError'], ['function', 'runtimePolicyCeilingCause']]],
    ['CheckpointRollbackService', [['const', 'isCheckpointRollbackExecutionError']]],
  ]) {
    const file = `apps/server/src/orchestration-v2/${relative}.ts`
    const api = file.replace('.ts', relative === 'Orchestrator' ? '.session-api.ts' : '.session-port.ts')
    for (const [kind, name] of symbols) author.replace(api, `\n${kind} ${name}`, `\nexport ${kind} ${name}`,
      `share-error-guard:${name}`)
    const first = author.read(file).match(/^import[\s\S]*?;/u)[0]
    author.replace(file, first,
      `import { ${symbols.map(([, name]) => name).join(', ')} } from "./${api.split('/').at(-1)}";\n${first}`,
      `import-error-guards:${relative}`)
  }
  const execution = 'apps/server/src/orchestration-v2/RunExecutionService.ts'
  const executionTarget = execution.replace('.ts', '.session-pure.ts')
  const routing = author.between(execution, 'export interface ProviderEventRoutingState', 'export class RunExecutionStartError extends')
  const interrupt = author.read(execution).slice(author.read(execution).indexOf('export const USER_STOP_REASON ='))
  const routingPrefix = author.between(execution, 'const NATIVE_SUBAGENT_TURN_ORIGIN:', 'const backgroundCapableTurnItemTypes:')
  // The analytics-only constant sits among routing declarations; it is not session behavior.
  const pureRouting = routing.replace(routingPrefix, '')
  author.derive(executionTarget, [selectedImports(author.read(execution), pureRouting + interrupt,
    execution, executionTarget, redirects),
  ...routing.split(routingPrefix).map(part => author.sourcePart(execution, part)),
  author.sourcePart(execution, interrupt)], 'extract-run-routing')
  redirects.set(execution, executionTarget)
  exports.set(execution, new Set(exportedNames(pureRouting + interrupt)))

  const sync = extractSync(author, redirects)
  const tagFile = 'apps/server/src/orchestration-v2/ThreadReadsTag.ts'
  author.add(tagFile, 'import * as Context from "effect/Context";\nimport type { ThreadReadShape } from "./ThreadReads.ts";\nexport class ThreadManagementService extends Context.Service<ThreadManagementService, ThreadReadShape>()("nessie/session-engine/ThreadReads") {}\n',
    'read-only-service-tag')
  redirectPortImports(author, snapshot, redirects, exports)
  for (const name of ['ResourceCleanupService', 'RunFinalizationService']) {
    const file = `apps/server/src/orchestration-v2/${name}.session-port.ts`
    const service = name === 'RunFinalizationService' ? 'RunFinalizationObserver' : name
    author.replace(file, `export class ${service} extends Context.Reference<{`,
      `export class ${service} extends Context.Service<${service}, {`, `required-owner:${service}`)
    const defaultStart = `}>("t3/orchestration-v2/${service}", {`
    const defaultBody = author.between(file, defaultStart, '}) {}') + '}) {}'
    author.replace(file, defaultBody, `}>()("t3/orchestration-v2/${service}") {}`, `remove-default-owner:${service}`)
  }
  author.replace('apps/server/src/orchestration-v2/EffectWorker.ts',
    '  | RunFinalizationService.RunFinalizationService\n',
    '  | RunFinalizationService.RunFinalizationService\n  | ResourceCleanupService.ResourceCleanupService\n',
    'require-worker-resource-owner')
  return { format: 1, sourceCommit: snapshot.identity.commit, roots: { ...reads, sync }, patches: author.patches }
}

const main = async () => {
  const snapshot = applySessionEngineBoundaryPatches(await readSessionEngineSnapshot(process.argv[2]))
  const manifest = generateExtractionManifest(snapshot)
  await writeFile(new URL('./boundary-patches.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`${manifest.patches.length} exact extraction operations\n`)
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
