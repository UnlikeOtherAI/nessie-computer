import { exportedNames, selectedImports } from './author.mjs'

/** One scoped selection service shared by cold inspection and authorized launch.
 * Cold construction requires only original stores, IDs, settings and clone state.
 * Workspace/provider services are acquired solely by the original launch layer. */
export const extractColdLaunch = (author, redirects, exports) => {
  const file = 'apps/server/src/orchestration-v2/ThreadLaunchService.ts'
  const port = file.replace('.ts', '.session-port.ts')
  const target = file.replace('ThreadLaunchService.ts', 'ThreadLaunchSelection.ts')
  const before = author.read(file)
  const contract = author.between(file, 'export type ThreadLaunchWorkspaceStrategy =', 'const isThreadLaunchError =')
  const portImports = selectedImports(before, contract, file, port, redirects)
    .replace('import * as ThreadManagement', 'import type * as ThreadManagement')
  author.derive(port, [portImports, author.sourcePart(file, contract, { current: true })], 'cold-launch-contract')
  const names = exportedNames(contract)
  const values = new Set([...contract.matchAll(/^export (?:class|const) (\w+)/gm)].map(match => match[1]))
  const bindings = names.map(name => `${values.has(name) ? '' : 'type '}${name}`).join(', ')
  author.replace(file, contract, `import { ${bindings} } from "./ThreadLaunchService.session-port.ts";
export { ${bindings} };

`, 'cold-launch-shared-contract')

  const body = author.between(file, '  const prepared =', '  const launch: ThreadLaunchService["Service"]["launch"]')
  const normalizationStart = body.indexOf('      // Scratch has no Git repository.')
  const commonStart = body.indexOf('      if (input.reuseExistingThread === true && input.threadId === undefined)')
  if (normalizationStart < 0 || commonStart < normalizationStart) throw new Error('Cold launch selection seam changed')
  const normalization = body.slice(normalizationStart, commonStart)
  const cloneStart = normalization.indexOf('      yield* ProjectCloneTracker.rejectCommandsDuringClone')
  if (cloneStart < 0) throw new Error('Cold launch clone seam changed')
  const inspectProject = normalization.slice(cloneStart)
    .replace('(inspection ? storedProjects.getShell(input.projectId) : projects.getById(input.projectId))',
      'storedProjects.getShell(input.projectId)')
  const fullProject = normalization
    .replace('!inspection && request.workspaceStrategy.type', 'request.workspaceStrategy.type')
    .replace('(inspection ? storedProjects.getShell(input.projectId) : projects.getById(input.projectId))',
      'projects.getById(input.projectId)')
  const validationStart = body.indexOf('        if (input.reuseExistingThread === true && Option.isNone(launchReceipt))')
  const validationEnd = body.indexOf('    const existing = prepared.get(input.commandId);', validationStart)
  if (validationStart < 0 || validationEnd < validationStart) throw new Error('Cold launch validation seam changed')
  const validation = body.slice(validationStart, validationEnd)
  const fullValidation = validation.replace(/          if \(inspection\)[^\n]+\n/u, '')
  if (fullValidation === validation) throw new Error('Cold launch inspection refusal seam changed')
  let selection = body.replace(normalization, '').replace(validation, '')
    .replace('function* (request: ThreadLaunchInput, inspection = false)',
      'function* (input: ThreadLaunchInput, project: ProjectSelection, request: ThreadLaunchInput = input)')
    .replace('threads.assertProviderInstanceEnabled(', 'assertProviderInstanceEnabled(')
    .replace('threads\n            .getThreadShell(', 'projections\n            .getThreadShell(')
    .replaceAll('resolveTarget(request, true)', 'inspectTarget(request)')
    .replaceAll('ThreadLaunchInput', 'ThreadLaunchSelectionInput')
  const inspect = `  const inspectTarget = Effect.fn("ThreadLaunchSelection.inspect")(function* (request: ThreadLaunchSelectionInput) {
    const input = request;
${inspectProject}
    const resolved = yield* resolveTarget(input, project);
    if (input.reuseExistingThread === true && Option.isNone(resolved.launchReceipt)) {
      return yield* mapError(input, "update-thread")("Existing empty-thread inspection requires admitted transcript preparation.");
    }
    return resolved;
  });

`
  selection = selection.replace('  const prepareTarget:', inspect + '  const prepareTarget:')
  const helpers = author.between(file, '  const mapError =', '  const validateReusableThread =')
    .replace('input: PreparationInput', 'input: ThreadLaunchSelectionInput')
    .replaceAll('ThreadLaunchInput', 'ThreadLaunchSelectionInput')
  const threads = 'apps/server/src/orchestration-v2/ThreadManagementLive.ts'
  const providerCheck = author.between(threads, '  const assertProviderInstanceEnabled:',
    '  const isProviderInstanceEnabledForProject:')
  const imports = selectedImports(before, helpers + selection + inspect, file, target, redirects)
    .replace('import * as ThreadManagement', 'import type * as ThreadManagement')
    + `import { resolveProjectProviderInstanceEnabled, type ProjectId } from "@t3tools/contracts";
import { ThreadLaunchError, selectThreadLaunchTargetInput, type ThreadLaunchSelectionInput,
  type ThreadLaunchService } from "./ThreadLaunchService.session-port.ts";
import { ThreadManagementProviderInstanceDisabledError, type ThreadManagementServiceShape } from "./ThreadManagementService.session-api.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
type ProjectSelection = { readonly id: ProjectId; readonly workspaceRoot: string };
`
  // `selectedImports` deliberately excludes services referenced only by removed
  // launch branches. Declare each real cold owner, never a partial fake service.
  const coldOwners = `const make = Effect.gen(function* () {
  const storedProjects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const cloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
`
  const selected = selectedImports(before, coldOwners, file, target, redirects)
  const combinedImports = [...new Set((imports + selected).split('\n').filter(Boolean))].join('\n') + '\n'
  author.derive(target, [combinedImports, coldOwners, helpers,
    author.sourcePart(threads, providerCheck, { current: true }), selection,
    `  return { resolveTarget, prepareTarget };
});
type SelectionShape<T> = T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;
export class ThreadLaunchSelection extends Context.Service<ThreadLaunchSelection, SelectionShape<typeof make>>()(
  "t3/orchestration-v2/ThreadLaunchSelection",
) {}
export const layer = Layer.effect(ThreadLaunchSelection, make);
`], 'cold-launch-original-selection')
  author.replace(file, body, '', 'cold-launch-remove-high-layer-selection')
  author.replace(file, '  const storedProjects = yield* ProjectStore.ProjectStoreV2;',
    '  const selection = yield* ThreadLaunchSelection;', 'cold-launch-consume-selection')
  author.replace(file, 'import * as ProjectStore from "./ProjectStore.ts";',
    'import { ThreadLaunchSelection } from "./ThreadLaunchSelection.ts";', 'cold-launch-selection-import')
  const call = '        const { input, project, launchReceipt, reusableLaunchReceipt, candidateThreadId } = yield* resolveTarget(request);'
  author.replace(file, call, `${fullProject}
      const { launchReceipt, reusableLaunchReceipt, candidateThreadId } = yield* selection.resolveTarget(input, project, request);
${fullValidation}`, 'cold-launch-authorized-preparation')
  author.replace(file, 'return ThreadLaunchService.of({ prepareTarget, launch,',
    'return ThreadLaunchService.of({ prepareTarget: selection.prepareTarget, launch,', 'cold-launch-forward-inspection')
  redirects.set(file, port)
  exports.set(file, new Set(names))
}
