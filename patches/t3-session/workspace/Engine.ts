import * as Layer from 'effect/Layer'
import * as Git from 't3-source:apps/server/src/git/GitWorkflowService.ts'
import * as Review from 't3-source:apps/server/src/review/ReviewService.ts'
import * as CheckpointStore from 't3-source:apps/server/src/checkpointing/CheckpointStore.ts'
import * as CheckpointDiffs from 't3-source:apps/server/src/checkpointing/CheckpointDiffQuery.ts'
import * as Provisioning from 't3-source:apps/server/src/vcs/VcsProvisioningService.ts'
import * as Checkpoints from 't3-source:apps/server/src/orchestration-v2/CheckpointService.ts'
import * as Rollback from 't3-source:apps/server/src/orchestration-v2/CheckpointRollbackService.ts'

/** Original services only. Requires held filesystem, Git and repository owners; activates no runtime. */
export const createWorkspaceLayers = () => {
  const checkpointStore = CheckpointStore.layer
  const checkpointDiffs = CheckpointDiffs.layer.pipe(Layer.provideMerge(checkpointStore))
  return { git: Git.layer, review: Review.layer, provisioning: Provisioning.layer,
    checkpointStore, checkpointDiffs,
    checkpoints: Checkpoints.layer.pipe(Layer.provideMerge(checkpointStore)), rollback: Rollback.layer }
}

export { Git, Review, CheckpointStore, CheckpointDiffs, Checkpoints, Rollback, Provisioning }
export * as Repository from 't3-source:apps/server/src/vcs/VcsDriverRegistry.session-port.ts'
export * as Status from 't3-source:apps/server/src/vcs/VcsStatusBroadcaster.session-port.ts'
export * as KnownWorkspaces from 't3-source:apps/server/src/workspace/KnownWorkspaces.session-port.ts'
export * as GitDriver from 't3-source:apps/server/src/vcs/GitVcsDriver.session-port.ts'
export * as GitManager from 't3-source:apps/server/src/git/GitManager.session-port.ts'
export * as Setup from 't3-source:apps/server/src/project/WorktreeSetupTracker.ts'
export * as SetupScripts from 't3-source:apps/server/src/project/ProjectSetupScriptRunner.session-port.ts'
export * as ManagedProjects from 't3-source:apps/server/src/project/ManagedProjectFolders.session-port.ts'
export * as PullRequests from 't3-source:apps/server/src/pullRequest/PullRequestService.session-port.ts'
export * as Projects from 't3-source:apps/server/src/project/ProjectService.session-port.ts'
export { linkCreatedPullRequest } from 't3-source:apps/server/src/git/linkCreatedPullRequest.ts'
export { refreshPushedPullRequests } from 't3-source:apps/server/src/git/refreshPushedPullRequests.ts'
export * as DiffFiles from 't3-source:apps/server/src/checkpointing/Diffs.ts'
export * as RestoreSafety from 't3-source:apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts'
