import * as Schema from 'effect/Schema'
import { OrchestrationV2Command, KnownComposerContextRecord,
  type OrchestrationMessageContext, type OrchestrationV2ThreadLaunchWorkspaceStrategy } from '@nessie/t3-session-source/contracts'
import ledger from './ledger.json' with { type: 'json' }

export interface ExecutorT3Target {
  readonly kind: 'thread' | 'project' | 'environment' | 'workspace' | 'attachment' | 'terminal'
    | 'scheduled-task' | 'provider-instance' | 'turn-item'
  readonly id: string
  readonly scope: 'existing' | 'create' | 'resolve'
  readonly environmentId?: string
}

export const workspaceTargets = (
  strategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined,
): ExecutorT3Target[] => strategy?.type === 'existing_worktree'
  ? [{ kind: 'workspace', id: strategy.worktreePath, scope: 'resolve' }] : []

export const contextTargets = (context: OrchestrationMessageContext | undefined): ExecutorT3Target[] => {
  if (!context) return []
  return context.records.flatMap((record): ExecutorT3Target[] => {
    if (!Schema.is(KnownComposerContextRecord)(record)) throw new Error('T3_UNCLASSIFIED_CONTEXT_RECORD')
    switch (record.kind) {
      case 'thread': return [{ kind: 'thread', id: record.threadId, environmentId: record.environmentId, scope: 'existing' }]
      case 'environment': return [{ kind: 'environment', id: record.environmentId, scope: 'existing' }]
      case 'image': case 'file': return [{ kind: 'attachment', id: record.attachmentId, scope: 'resolve' }]
      case 'terminal': return [{ kind: 'terminal', id: record.terminalId, scope: 'resolve' }]
      case 'mention': return [{ kind: 'workspace', id: record.path, scope: 'resolve' }]
      case 'review-comment': return [{ kind: 'workspace', id: record.filePath, scope: 'resolve' }]
      case 'element': return record.source?.fileName ? [{ kind: 'workspace', id: record.source.fileName, scope: 'resolve' }] : []
      case 'preview-annotation': return (record.elements ?? []).flatMap(element => element.source?.fileName
        ? [{ kind: 'workspace' as const, id: element.source.fileName, scope: 'resolve' as const }] : [])
      case 'skill': return []
      default: { const exhaustive: never = record; return exhaustive }
    }
  })
}

/** Internal reactor records stay internal even when upstream's public union contains them. */
export const requireClientCommand = (command: OrchestrationV2Command): void => {
  const rule = ledger.commands[command.type]
  if (rule.status !== 'pending') throw new Error('T3_INTERNAL_OR_EXCLUDED_COMMAND')
  if ('linkOrigin' in command && command.linkOrigin !== undefined
    || 'delegatedFrom' in command && command.delegatedFrom !== undefined
    || 'importedNativeThread' in command && command.importedNativeThread !== undefined
    || 'notification' in command && command.notification !== undefined
    || 'guestMessageId' in command && command.guestMessageId !== undefined
    || 'scheduledTaskId' in command && command.scheduledTaskId !== undefined
    || 'senderThreadId' in command && command.senderThreadId !== undefined
    || 'idleCompaction' in command && command.idleCompaction !== undefined
    || 'delegatedCompletion' in command && command.delegatedCompletion !== undefined
    || 'limitRecovery' in command && command.limitRecovery !== undefined
    || 'usageLimitContinuationOfRunId' in command && command.usageLimitContinuationOfRunId !== undefined
    || 'usageLimitRecoveryRequestId' in command && command.usageLimitRecoveryRequestId !== undefined
    || 'context' in command && command.context?.guest !== undefined) throw new Error('T3_TRUSTED_PROVENANCE_ONLY')
  // All request answers use the existing one-use sealed session-action lane.
  if (command.type === 'runtime-request.respond') throw new Error('T3_SEALED_ANSWER_REQUIRED')
  if ('context' in command) contextTargets(command.context)
}

/** Call only after the original command codec has decoded the body. */
export const commandTargets = (command: OrchestrationV2Command): readonly ExecutorT3Target[] => {
  requireClientCommand(command)
  const targets: ExecutorT3Target[] = []
  if ('threadId' in command) targets.push({ kind: 'thread', id: command.threadId,
    scope: command.type === 'thread.create' ? 'create' : 'existing' })
  if ('projectId' in command) targets.push({ kind: 'project', id: command.projectId, scope: 'existing' })
  if ('parentThreadId' in command) targets.push({ kind: 'thread', id: command.parentThreadId, scope: 'existing' })
  if ('sourceThreadId' in command) targets.push({ kind: 'thread', id: command.sourceThreadId, scope: 'existing' })
  if ('targetThreadId' in command) targets.push({ kind: 'thread', id: command.targetThreadId,
    scope: command.type === 'thread.fork' ? 'create' : 'existing' })
  if (command.type === 'delegated_task.request') targets.push({ kind: 'thread', id: command.parentThreadId, scope: 'create' })
  if (command.type === 'message.dispatch' && command.sourcePlanRef) {
    targets.push({ kind: 'thread', id: command.sourcePlanRef.threadId, scope: 'existing' })
  }
  if ('context' in command) targets.push(...contextTargets(command.context))
  if ('worktreePath' in command && command.worktreePath) {
    targets.push({ kind: 'workspace', id: command.worktreePath, scope: 'resolve' })
  }
  if ('workspaceStrategy' in command) targets.push(...workspaceTargets(command.workspaceStrategy))
  if (command.type === 'message.dispatch' && command.dispatchMode.type === 'defer_start') {
    targets.push(...workspaceTargets(command.dispatchMode.workspaceStrategy))
  }
  if ('attachments' in command && command.attachments) {
    for (const attachment of command.attachments) targets.push({ kind: 'attachment', id: attachment.id, scope: 'resolve' })
  }
  return targets
}

export const ClientCommand = OrchestrationV2Command.check(Schema.makeFilter(command => {
  try { requireClientCommand(command); return true } catch { return false }
}))

/** After one-use unsealing and original-codec validation, before live callback admission. */
export const sealedAnswerTargets = (
  command: Extract<OrchestrationV2Command, { readonly type: 'runtime-request.respond' }>,
): readonly ExecutorT3Target[] => [{ kind: 'thread', id: command.threadId, scope: 'existing' },
  ...Object.values(command.attachmentsByQuestionId ?? {}).flatMap(attachments => attachments.map(attachment => ({
    kind: 'attachment' as const, id: attachment.id, scope: 'resolve' as const,
  }))) ]
