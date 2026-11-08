import type { ExecutorT3ImplementationSlots } from '@nessie/executor-protocol/t3-session'
import { CommandId, OrchestrationGetFullThreadDiffError, OrchestrationGetTurnDiffError,
  type GitActionProgressEvent, type GitManagerServiceError } from '@nessie/t3-session-source/contracts'
import { Workspace, Orchestrator, ProjectStore } from '@nessie/t3-session-source/engine'
import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'

/**
 * Internal service calls, NOT admitted executor slots. The caller must hold the canonical runtime,
 * workspace and receipt scope for the entire effect/stream, including PR completion and refresh.
 * No default layers, production binding or success-returning authority callbacks are supplied here.
 * Launch/rewind/PR commands remain the lifecycle owner's original launch/dispatch operations.
 */
export const makeWorkspaceReadOperations = Effect.gen(function* () {
  const review = yield* Workspace.Review.ReviewService
  const diffs = yield* Workspace.CheckpointDiffs.CheckpointDiffQuery
  return {
    'review.getBranchCommits': (input) => review.getBranchCommits(input),
    'review.getDiffPreview': (input) => review.getDiffPreview(input),
    'review.getDiffFileContents': (input) => review.getDiffFileContents(input),
    'orchestration.getTurnDiff': (input) => diffs.getTurnDiff(input).pipe(Effect.mapError(cause =>
      new OrchestrationGetTurnDiffError({ message: 'Failed to load turn diff', cause }))),
    'orchestration.getFullThreadDiff': (input) => diffs.getFullThreadDiff(input).pipe(Effect.mapError(cause =>
      new OrchestrationGetFullThreadDiffError({ message: 'Failed to load full thread diff', cause }))),
  } satisfies ExecutorT3ImplementationSlots
})

export const makeWorkspaceStatusOperations = Effect.gen(function* () {
  const status = yield* Workspace.Status.VcsStatusBroadcaster
  const setup = yield* Workspace.Setup.WorktreeSetupTracker
  return {
    'subscribeVcsStatus': (input) => status.streamStatus(input),
    'subscribeWorktreeSetup': (input) => setup.stream(input.threadId),
  } satisfies ExecutorT3ImplementationSlots
})

export const makeWorkspaceMutationOperations = Effect.gen(function* () {
  const git = yield* Workspace.Git.GitWorkflowService
  const status = yield* Workspace.Status.VcsStatusBroadcaster
  const setup = yield* Workspace.Setup.WorktreeSetupTracker
  const provisioning = yield* Workspace.Provisioning.VcsProvisioningService
  const engine = yield* Orchestrator.OrchestratorV2
  const projects = yield* Workspace.Projects.ProjectService
  const projectStore = yield* ProjectStore.ProjectStoreV2
  const pullRequests = yield* Workspace.PullRequests.PullRequestService

  // Unlike a detached refresh, this remains inside the admitted operation's lifetime.
  // Failure cannot turn a completed Git mutation into permission to repeat it.
  const refresh = (cwd: string) => status.refreshStatus(cwd).pipe(Effect.ignore, Effect.asVoid)
  return {
    'worktreeSetup.cancel': (input) => setup.cancel(input.threadId).pipe(Effect.map(cancelled => ({ cancelled }))),
    'vcs.refreshStatus': (input) => status.refreshStatus(input.cwd, { localOnly: input.localOnly ?? false }),
    'vcs.pull': (input) => git.pullCurrentBranch(input.cwd).pipe(Effect.tap(() => refresh(input.cwd))),
    'vcs.listRefs': (input) => git.listRefs(input),
    'vcs.createWorktree': (input) => git.createWorktree(input).pipe(Effect.tap(() => refresh(input.cwd))),
    'vcs.removeWorktree': (input) => git.removeWorktree(input).pipe(Effect.tap(() => refresh(input.cwd))),
    'vcs.createRef': (input) => git.createRef(input).pipe(Effect.tap(() => refresh(input.cwd))),
    'vcs.switchRef': (input) => git.switchRef(input).pipe(Effect.tap(() => refresh(input.cwd))),
    'vcs.init': (input) => provisioning.initRepository(input).pipe(Effect.tap(() => refresh(input.cwd))),
    'git.resolvePullRequest': (input) => git.resolvePullRequest(input),
    'git.preparePullRequestThread': (input) => git.preparePullRequestThread(input)
      .pipe(Effect.tap(() => refresh(input.cwd))),
    'git.runStackedAction': (input) => Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
      git.runStackedAction(input, { actionId: input.actionId,
        progressReporter: { publish: event => Queue.offer(queue, event).pipe(Effect.asVoid) },
      }).pipe(Effect.matchCauseEffect({
        onFailure: cause => Queue.failCause(queue, cause),
        onSuccess: result => (input.threadId === undefined ? Effect.void : Workspace.linkCreatedPullRequest({
          threadId: input.threadId, result,
          // Stable across receipt reconciliation. JSON tuple encoding prevents delimiter collisions.
          commandId: Effect.succeed(CommandId.make(JSON.stringify([
            'nessie.workspace.pr-created', input.threadId, input.actionId,
          ]))),
        })).pipe(
          Effect.andThen(Workspace.refreshPushedPullRequests(input, result)),
          Effect.provideService(Orchestrator.OrchestratorV2, engine),
          Effect.provideService(Workspace.Projects.ProjectService, projects),
          Effect.provideService(ProjectStore.ProjectStoreV2, projectStore),
          Effect.provideService(Workspace.PullRequests.PullRequestService, pullRequests),
          Effect.andThen(refresh(input.cwd)),
          Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
        ),
      })), { bufferSize: 32 }),
  } satisfies ExecutorT3ImplementationSlots
})
