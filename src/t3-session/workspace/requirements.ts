import { requestTargets, commandTargets, type ExecutorT3Target } from '@nessie/executor-protocol/t3-session'
import type { WorkspaceCommand, WorkspaceRequest } from './contracts.js'
import { requireWorkspaceReceipt } from './contracts.js'

/** Resolution obligations, never grants or proof that a path is safe. Preserve exact source IDs. */
export type WorkspaceRequirement =
  | { readonly kind: 'target'; readonly target: ExecutorT3Target }
  | { readonly kind: 'repository'; readonly cwd: string }
  | { readonly kind: 'relative-file'; readonly cwd: string; readonly path: string }
  | { readonly kind: 'worktree'; readonly cwd: string; readonly path: string | null;
      readonly intent: 'create' | 'remove' }
  | { readonly kind: 'launch'; readonly input: Extract<WorkspaceRequest,
      { method: 'orchestration.launchThread' }>['input'] }
  | { readonly kind: 'checkpoint-range'; readonly input: Extract<WorkspaceRequest,
      { method: 'orchestration.getTurnDiff' | 'orchestration.getFullThreadDiff' }>['input'] }
  | { readonly kind: 'rewind'; readonly command: Extract<WorkspaceCommand, { type: 'checkpoint.rollback' }> }
  | { readonly kind: 'pull-request'; readonly command: Exclude<WorkspaceCommand, { type: 'checkpoint.rollback' }> }

/** Run after the original codec and before receipt admission. All referenced owners must resolve. */
export const workspaceRequirements = (request: WorkspaceRequest): readonly WorkspaceRequirement[] => {
  requireWorkspaceReceipt(request)
  const requirements: WorkspaceRequirement[] = requestTargets(request).map(target => ({ kind: 'target', target }))
  const input = request.input
  if ('cwd' in input) requirements.push({ kind: 'repository', cwd: input.cwd })
  switch (request.method) {
    case 'orchestration.launchThread':
      requirements.push({ kind: 'launch', input: request.input })
      break
    case 'orchestration.getTurnDiff': case 'orchestration.getFullThreadDiff':
      requirements.push({ kind: 'checkpoint-range', input: request.input })
      break
    case 'vcs.createWorktree': case 'vcs.removeWorktree':
      requirements.push({ kind: 'worktree', cwd: request.input.cwd, path: request.input.path,
        intent: request.method === 'vcs.createWorktree' ? 'create' : 'remove' })
      break
    case 'review.getDiffPreview':
      if (request.input.file) {
        for (const path of [request.input.file.path, request.input.file.previousPath]) {
          if (path !== null) requirements.push({ kind: 'relative-file', cwd: request.input.cwd, path })
        }
      }
      break
    case 'review.getDiffFileContents':
      for (const path of [request.input.oldPath, request.input.newPath]) {
        requirements.push({ kind: 'relative-file', cwd: request.input.cwd, path })
      }
      break
    case 'git.runStackedAction':
      for (const path of request.input.filePaths ?? []) {
        requirements.push({ kind: 'relative-file', cwd: request.input.cwd, path })
      }
      break
  }
  return requirements
}

/** Keep rewind and PR mutations on orchestration.dispatchCommand and its atomic receipt. */
export const workspaceCommandRequirements = (command: WorkspaceCommand): readonly WorkspaceRequirement[] => [
  ...commandTargets(command).map((target): WorkspaceRequirement => ({ kind: 'target', target })),
  command.type === 'checkpoint.rollback' ? { kind: 'rewind', command } : { kind: 'pull-request', command },
]
