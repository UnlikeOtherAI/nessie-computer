import * as Schema from 'effect/Schema'
import { AssetResource } from '@nessie/t3-session-source/contracts'
import { commandTargets, contextTargets, workspaceTargets, type ExecutorT3Target } from './commands.js'
import type { ExecutorT3Request } from './request.js'

/** Resolve attachments against their owning thread; paths against admitted roots. */
export const resourceTargets = (resource: AssetResource): readonly ExecutorT3Target[] => {
  switch (resource._tag) {
    case 'workspace-file': case 'media-file':
      return [{ kind: 'thread', id: resource.threadId, scope: 'existing' },
        { kind: 'workspace', id: resource.path, scope: 'resolve' }]
    case 'tool-output-image':
      return [{ kind: 'thread', id: resource.threadId, scope: 'existing' }]
    case 'attachment': return [{ kind: 'attachment', id: resource.attachmentId, scope: 'resolve' }]
    case 'draft-workspace-file': case 'project-favicon': case 'github-media':
      return [{ kind: 'workspace', id: resource.cwd, scope: 'resolve' }]
    case 'native-app-icon': throw new Error('T3_RESOURCE_OWNER_REQUIRED')
    default: { const exhaustive: never = resource; return exhaustive }
  }
}

type TargetRequest<R> = R extends ExecutorT3Request
  ? Pick<R, 'method' | 'input'> & { readonly sourceThreadId?: R['sourceThreadId'] } : never

/** Original decoded inputs only. Extraction may precede broker routing; it
 * never requires fabricated epoch/generation fields. Method/input correlation
 * and the optional original route-hint consistency check are preserved.
 */
export const requestTargets = (request: TargetRequest<ExecutorT3Request>): readonly ExecutorT3Target[] => {
  if (request.method === 'orchestration.dispatchCommand') {
    const targets = commandTargets(request.input)
    requireRouteTarget(request.sourceThreadId, targets)
    return targets
  }
  const input = request.input
  const targets: ExecutorT3Target[] = []
  if (!input || typeof input !== 'object') {
    requireRouteTarget(request.sourceThreadId, targets)
    return targets
  }
  if ('threadId' in input && input.threadId) targets.push({ kind: 'thread', id: input.threadId,
    scope: request.method === 'orchestration.launchThread' && !request.input.reuseExistingThread ? 'create' : 'existing' })
  if ('threadIds' in input) for (const id of input.threadIds) targets.push({ kind: 'thread', id, scope: 'existing' })
  if ('conversationThreadId' in input && input.conversationThreadId) {
    targets.push({ kind: 'thread', id: input.conversationThreadId, scope: 'existing' })
  }
  if ('projectId' in input && input.projectId) targets.push({ kind: 'project', id: input.projectId,
    scope: request.method === 'projects.mutate' && request.input.type === 'project.create' ? 'create' : 'existing' })
  if ('projectIds' in input && input.projectIds) {
    for (const id of input.projectIds) targets.push({ kind: 'project', id, scope: 'existing' })
  }
  if ('resource' in input && Schema.is(AssetResource)(input.resource)) targets.push(...resourceTargets(input.resource))
  if ('attachmentId' in input) targets.push({ kind: 'attachment', id: input.attachmentId, scope: 'resolve' })
  if ('cwd' in input && input.cwd) targets.push({ kind: 'workspace', id: input.cwd, scope: 'resolve' })
  if ('workspaceRoot' in input && input.workspaceRoot) {
    targets.push({ kind: 'workspace', id: input.workspaceRoot, scope: 'resolve' })
  }
  if ('worktreePath' in input && input.worktreePath) targets.push({ kind: 'workspace', id: input.worktreePath, scope: 'resolve' })
  if ('workspaceStrategy' in input) targets.push(...workspaceTargets(input.workspaceStrategy))
  if ('relativePath' in input) targets.push({ kind: 'workspace', id: input.relativePath, scope: 'resolve' })
  if ('directoryPath' in input && input.directoryPath) targets.push({ kind: 'workspace', id: input.directoryPath, scope: 'resolve' })
  if ('partialPath' in input) targets.push({ kind: 'workspace', id: input.partialPath, scope: 'resolve' })
  if ('path' in input && input.path) targets.push({ kind: 'workspace', id: input.path, scope: 'resolve' })
  if ('oldPath' in input && input.oldPath) targets.push({ kind: 'workspace', id: input.oldPath, scope: 'resolve' })
  if ('newPath' in input && input.newPath) targets.push({ kind: 'workspace', id: input.newPath, scope: 'resolve' })
  if ('scriptPath' in input) targets.push({ kind: 'workspace', id: input.scriptPath, scope: 'resolve' })
  if ('paths' in input) for (const id of input.paths) targets.push({ kind: 'workspace', id, scope: 'resolve' })
  if ('terminalId' in input && input.terminalId) targets.push({ kind: 'terminal', id: input.terminalId, scope: 'resolve' })
  if ('itemId' in input) targets.push({ kind: 'turn-item', id: input.itemId, scope: 'resolve' })
  if ('instanceId' in input && input.instanceId) targets.push({ kind: 'provider-instance', id: input.instanceId, scope: 'resolve' })
  switch (request.method) {
    case 'scheduledTasks.upsert': case 'scheduledTasks.setEnabled': case 'scheduledTasks.delete':
    case 'scheduledTasks.runNow':
      if (request.input.id) targets.push({ kind: 'scheduled-task', id: request.input.id, scope: 'resolve' })
      break
    case 'server.updateSettings': {
      const patch = request.input.patch
      for (const row of [...patch.setModelFavorites ?? [], ...patch.setModelsHidden ?? []]) {
        targets.push({ kind: 'provider-instance', id: row.provider, scope: 'resolve' })
      }
      if (patch.setProviderModelOrder) targets.push({ kind: 'provider-instance',
        id: patch.setProviderModelOrder.provider, scope: 'resolve' })
    }
  }
  if (request.method === 'orchestration.launchThread' && request.input.initialMessage?.context) {
    targets.push(...contextTargets(request.input.initialMessage.context))
  }
  if (request.method === 'orchestration.launchThread' && request.input.initialMessage) {
    for (const attachment of request.input.initialMessage.attachments) {
      targets.push({ kind: 'attachment', id: attachment.id, scope: 'resolve' })
    }
  }
  requireRouteTarget(request.sourceThreadId, targets)
  return targets
}

const requireRouteTarget = (threadId: string | undefined, targets: readonly ExecutorT3Target[]): void => {
  if (threadId && !targets.some(target => target.kind === 'thread' && target.id === threadId)) {
    throw new Error('T3_ROUTE_TARGET_MISMATCH')
  }
}
