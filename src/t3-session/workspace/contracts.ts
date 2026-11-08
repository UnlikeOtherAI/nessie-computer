import type { ExecutorT3Descriptor, ExecutorT3Request } from '@nessie/executor-protocol/t3-session'
import type { OrchestrationV2Command } from '@nessie/t3-session-source/contracts'
import type * as RpcSchema from 'effect/rpc/RpcSchema'

/** Canonical operation names, not new tools. Registrations belong to the shared gateway/tool owners. */
export const workspaceOperations = {
  'orchestration.launchThread': { mode: 'finite', grant: 'create', receipt: 'command' },
  'orchestration.getWorktreeThreadIds': { mode: 'finite', grant: 'read', receipt: 'none' },
  'orchestration.getTurnDiff': { mode: 'finite', grant: 'read', receipt: 'none' },
  'orchestration.getFullThreadDiff': { mode: 'finite', grant: 'read', receipt: 'none' },
  'subscribeVcsStatus': { mode: 'stream', grant: 'read', receipt: 'none' },
  'subscribeWorktreeSetup': { mode: 'stream', grant: 'read', receipt: 'none' },
  'worktreeSetup.cancel': { mode: 'finite', grant: 'control', receipt: 'command' },
  'vcs.pull': { mode: 'finite', grant: 'control', receipt: 'command' },
  'vcs.refreshStatus': { mode: 'finite', grant: 'read', receipt: 'command' },
  'vcs.listRefs': { mode: 'finite', grant: 'read', receipt: 'conditional-refresh' },
  'vcs.createWorktree': { mode: 'finite', grant: 'control', receipt: 'command' },
  'vcs.removeWorktree': { mode: 'finite', grant: 'control', receipt: 'command' },
  'vcs.createRef': { mode: 'finite', grant: 'control', receipt: 'command' },
  'vcs.switchRef': { mode: 'finite', grant: 'control', receipt: 'command' },
  'vcs.init': { mode: 'finite', grant: 'control', receipt: 'command' },
  'git.resolvePullRequest': { mode: 'finite', grant: 'read', receipt: 'none' },
  'git.preparePullRequestThread': { mode: 'finite', grant: 'control', receipt: 'command' },
  'git.runStackedAction': { mode: 'stream', grant: 'control', receipt: 'command-and-action' },
  'review.getBranchCommits': { mode: 'finite', grant: 'read', receipt: 'none' },
  'review.getDiffPreview': { mode: 'finite', grant: 'read', receipt: 'none' },
  'review.getDiffFileContents': { mode: 'finite', grant: 'read', receipt: 'none' },
} as const

export type WorkspaceMethod = keyof typeof workspaceOperations
export type WorkspaceRequest = Extract<ExecutorT3Request, { readonly method: WorkspaceMethod }>
export type WorkspaceInput<M extends WorkspaceMethod> = ExecutorT3Descriptor<M>['payloadSchema']['Type']
export type WorkspaceOutput<M extends WorkspaceMethod> = ExecutorT3Descriptor<M>['successSchema'] extends
  RpcSchema.Stream<infer A, infer _E> ? A['Type'] : ExecutorT3Descriptor<M>['successSchema']['Type']

export const workspaceCommandTypes = [
  'checkpoint.rollback', 'thread.pull-request.link', 'thread.pull-request.unlink', 'thread.pull-request.watch',
] as const satisfies readonly OrchestrationV2Command['type'][]
export type WorkspaceCommand = Extract<OrchestrationV2Command, { type: typeof workspaceCommandTypes[number] }>

export const isWorkspaceRequest = (request: ExecutorT3Request): request is WorkspaceRequest =>
  Object.hasOwn(workspaceOperations, request.method)

/** No mutation replay through a new ID: reconnect reconciles the original command/action receipt. */
export const requiresWorkspaceReceipt = (request: WorkspaceRequest): boolean => {
  if (request.method === 'vcs.listRefs') return request.input.refresh === true
  return workspaceOperations[request.method].receipt !== 'none'
}

export const requireWorkspaceReceipt = (request: WorkspaceRequest): void => {
  if (requiresWorkspaceReceipt(request) && !request.commandId) throw new Error('T3_WORKSPACE_RECEIPT_REQUIRED')
}
