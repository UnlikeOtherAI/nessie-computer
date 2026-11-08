import * as DateTime from 'effect/DateTime'
import { Shell, SourceContracts as C } from '@nessie/t3-session-source/client'

export const now = '2026-11-08T12:00:00.000Z'
export const rawThread = (id, overrides = {}) => ({
  id: C.ThreadId.make(id), projectId: C.ProjectId.make('project-a'), title: id,
  providerInstanceId: C.ProviderInstanceId.make('codex'),
  modelSelection: { instanceId: C.ProviderInstanceId.make('codex'), model: 'fixture-model' },
  runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: C.ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  forkedFrom: null, createdBy: 'user', creationSource: 'mobile', latestRunId: null, activeRunId: null,
  status: 'idle', pendingRuntimeRequest: null, latestVisibleMessage: null, latestUserMessageAt: null,
  hasActionableProposedPlan: false, itemCount: 0, visibleItemCount: 0,
  createdAt: DateTime.makeUnsafe(now), updatedAt: DateTime.makeUnsafe(now), archivedAt: null,
  settledOverride: null, settledAt: null, deletedAt: null, ...overrides,
})
export const thread = (environment, id, overrides = {}) => ({
  ...Shell.presentThreadShell(C.EnvironmentId.make(environment), rawThread(id)), ...overrides,
})
export const archived = (id, date) => rawThread(id, { archivedAt: DateTime.makeUnsafe(date) })
