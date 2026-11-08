/** Split the original launch's read/ID selection from its mutating preparation.
 * The launch body still owns attachments, worktrees, command acceptance and runs.
 * A prepared ID lives only in this same original service's enclosing scope. */
export const extractPrelaunch = author => {
  const file = 'apps/server/src/orchestration-v2/ThreadLaunchService.ts'
  author.replace(file, 'import * as CommandReceiptStore from "./CommandReceiptStore.ts";',
    'import * as ProjectStore from "./ProjectStore.ts";\n'
      + 'import * as CommandReceiptStore from "./CommandReceiptStore.ts";', 'prelaunch-stored-project-import')
  author.replace(file, '  const projects = yield* ProjectService.ProjectService;',
    '  const projects = yield* ProjectService.ProjectService;\n'
      + '  const storedProjects = yield* ProjectStore.ProjectStoreV2;', 'prelaunch-stored-project-owner')
  const target = `/** Fields used by nonexecuting ID/project/provider selection only. */
export type ThreadLaunchSelectionInput = Pick<ThreadLaunchInput,
  "commandId" | "threadId" | "reuseExistingThread" | "projectId" | "modelSelection">;

export const selectThreadLaunchTargetInput = (input: ThreadLaunchSelectionInput): ThreadLaunchSelectionInput => ({
  commandId: input.commandId, projectId: input.projectId, modelSelection: input.modelSelection,
  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  ...(input.reuseExistingThread === undefined ? {} : { reuseExistingThread: input.reuseExistingThread }),
});

export interface ThreadLaunchTarget {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly providerInstanceId: ThreadLaunchInput["modelSelection"]["instanceId"];
  readonly workspaceRoot: string;
  readonly assertCurrent: Effect.Effect<void,
    ThreadLaunchError | ThreadManagement.ThreadManagementProviderInstanceDisabledError>;
}

`
  author.replace(file, 'export class ThreadLaunchService extends', target + 'export class ThreadLaunchService extends',
    'prelaunch-target-type')
  author.replace(file, '    readonly launch: (\n', `    readonly prepareTarget: (input: ThreadLaunchSelectionInput) =>
      Effect.Effect<ThreadLaunchTarget,
        ThreadLaunchError | ThreadManagement.ThreadManagementProviderInstanceDisabledError, Scope.Scope>;
    readonly launch: (
`, 'prelaunch-target-service')

  const start = '  const launch: ThreadLaunchService["Service"]["launch"] = Effect.fn("ThreadLaunchService.launch")(\n    function* (request) {\n'
  const nested = '      return yield* Effect.gen(function* () {\n'
  const end = '        const workspaceStrategy: ThreadLaunchWorkspaceStrategy ='
  const prefix = author.between(file, start, end)
  if (prefix.split(nested).length !== 2) throw new Error('Prelaunch original selection seam changed')
  const originalSelection = prefix.slice(start.length).replace(nested, '')
  const cachedSelection = originalSelection.replace('          reusableLaunchReceipt?.threadId ??\n',
    '          reusableLaunchReceipt?.threadId ??\n          prepared.get(input.commandId)?.threadId ??\n')
    .replace('request.workspaceStrategy.type === "worktree" &&',
      '!inspection && request.workspaceStrategy.type === "worktree" &&')
    .replace('projects.getById(input.projectId).pipe(',
      '(inspection ? storedProjects.getShell(input.projectId) : projects.getById(input.projectId)).pipe(')
    .replace('          yield* validateReusableThread(input, candidateThreadId);',
      '          if (inspection) return yield* mapError(input, "update-thread")'
        + '("Existing empty-thread inspection requires admitted transcript preparation.");\n'
        + '          yield* validateReusableThread(input, candidateThreadId);')
  if (cachedSelection === originalSelection) throw new Error('Prelaunch original ID allocation seam changed')
  const replacement = `  const prepared = new Map<CommandId, {
    readonly signature: string; readonly threadId: ThreadId; holders: number;
  }>();
  yield* Effect.addFinalizer(() => Effect.sync(() => prepared.clear()));
  // Selection retains only the fields it consumes, never creation provenance.
  // The enclosing signed command still binds its full original request and the
  // admitted launch keeps the original complete receipt/digest semantics.
  const selectionSignature = (input: ThreadLaunchInput) =>
    JSON.stringify(selectThreadLaunchTargetInput(input));
  const resolveTarget = Effect.fn("ThreadLaunchService.resolveTarget")(
    function* (request: ThreadLaunchInput, inspection = false) {
${cachedSelection}
    const existing = prepared.get(input.commandId);
    if (existing && (existing.signature !== selectionSignature(request) || existing.threadId !== candidateThreadId)) {
      return yield* mapError(input, "create-thread")("Prepared launch target changed.");
    }
    return { input, project, launchReceipt, reusableLaunchReceipt, candidateThreadId };
  });

  const prepareTarget: ThreadLaunchService["Service"]["prepareTarget"] = Effect.fn(
    "ThreadLaunchService.prepareTarget",
  )(function* (request) {
    const resolved = yield* resolveTarget(request, true);
    const { input, project, candidateThreadId } = resolved;
    let record = prepared.get(input.commandId);
    if (record && (record.signature !== selectionSignature(request) || record.threadId !== candidateThreadId)) {
      return yield* mapError(input, "create-thread")("Concurrent launch target changed.");
    }
    if (!record) {
      if (prepared.size >= 64) return yield* mapError(input, "create-thread")("Launch target capacity reached.");
      record = { signature: selectionSignature(request), threadId: candidateThreadId, holders: 0 };
      prepared.set(input.commandId, record);
    }
    const held = record;
    held.holders++;
    let active = true;
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      active = false;
      if (--held.holders === 0 && prepared.get(input.commandId) === held) prepared.delete(input.commandId);
    }));
    const assertCurrent = Effect.gen(function* () {
      if (!active || prepared.get(input.commandId) !== held) {
        return yield* mapError(input, "create-thread")("Launch target scope closed.");
      }
      const current = yield* resolveTarget(request, true);
      if (current.candidateThreadId !== candidateThreadId || current.project.id !== project.id
        || current.project.workspaceRoot !== project.workspaceRoot) {
        return yield* mapError(input, "resolve-project")("Launch target identity changed.");
      }
    });
    yield* assertCurrent;
    return Object.freeze({ threadId: candidateThreadId, projectId: project.id,
      providerInstanceId: input.modelSelection.instanceId, workspaceRoot: project.workspaceRoot, assertCurrent });
  });

${start}        const { input, project, launchReceipt, reusableLaunchReceipt, candidateThreadId } = yield* resolveTarget(request);
${nested}`
  author.replace(file, prefix, replacement, 'prelaunch-original-read-selection')
  author.replace(file, 'return ThreadLaunchService.of({ launch, checkWorktreeBase, retryPreparation, prepareRun });',
    'return ThreadLaunchService.of({ prepareTarget, launch, checkWorktreeBase, retryPreparation, prepareRun });',
    'prelaunch-live-selection-export')
}
