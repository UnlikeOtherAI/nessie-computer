import { createPatchAuthor, exportedNames, selectedImports } from '../extraction/author.mjs'
import { posix } from 'node:path'

const root = 'apps/server/src/'

/** Run after the existing extraction family. No source implementation is transcribed. */
export const generateWorkspaceManifest = snapshot => {
  const author = createPatchAuthor(snapshot)
  // This family follows extraction. Bind fragments to that exact current stage,
  // rather than interpreting offsets in derived files as original-capsule offsets.
  const sourcePart = (file, text) => author.sourcePart(file, text, { current: true })
  const redirects = new Map([
    ['config.ts', 'config.session-port.ts'],
    ['serverSettings.ts', 'serverSettings.session-port.ts'],
    ['git/GitWorkflowService.ts', 'git/GitWorkflowService.session-port.ts'],
    ['git/GitManager.ts', 'git/GitManager.session-port.ts'],
    ['vcs/GitVcsDriver.ts', 'vcs/GitVcsDriver.session-port.ts'],
    ['orchestration-v2/ThreadManagementService.ts', 'orchestration-v2/ThreadManagementService.session-api.ts'],
    ['orchestration-v2/Orchestrator.ts', 'orchestration-v2/Orchestrator.session-api.ts'],
    ['project/ProjectService.ts', 'project/ProjectService.session-port.ts'],
    ['orchestration-v2/ProviderSessionManager.ts', 'orchestration-v2/ProviderSessionManager.session-port.ts'],
  ].map(([from, to]) => [root + from, root + to]))

  // These declarations retain the original Context tag. Their live owners are deliberately not supplied.
  for (const [file, start, end] of [
    ['vcs/VcsDriverRegistry.ts', 'export interface VcsDriverResolveInput', 'function detectionCacheKey('],
    ['vcs/VcsStatusBroadcaster.ts', 'export class VcsStatusBroadcaster extends', 'function fingerprintStatusPart('],
    ['workspace/KnownWorkspaces.ts', 'export class UnknownWorkspaceError extends', '/** @public */'],
  ]) {
    const source = root + file
    const target = source.replace('.ts', '.session-port.ts')
    redirects.set(source, target)
    const body = author.between(source, start, end)
    author.derive(target, [selectedImports(author.read(source), body, source, target, redirects),
      sourcePart(source, body)], `workspace-port:${file}`)
    const names = exportedNames(body)
    const values = new Set([...body.matchAll(/^export (?:class|const|function) (\w+)/gm)].map(match => match[1]))
    const bindings = names.map(name => `${values.has(name) ? '' : 'type '}${name}`).join(', ')
    author.replace(source, body,
      `import { ${bindings} } from "./${target.split('/').at(-1)}";\nexport { ${bindings} };\n\n`,
      `workspace-share-port:${file}`)
  }

  const pullRequests = root + 'pullRequest/PullRequestService.ts'
  const pullRequestPort = pullRequests.replace('.ts', '.session-port.ts')
  const pullRequestBody = [
    author.between(pullRequests, 'export interface PullRequestMergeEvent extends', 'type PullRequestReading ='),
    'export type PullRequestError = PullRequestUnavailableError | PullRequestOperationError;\n',
    author.between(pullRequests, 'export class PullRequestService extends', 'const VERDICT_LABELS:'),
  ]
  author.derive(pullRequestPort, [selectedImports(author.read(pullRequests), pullRequestBody.join(''),
    pullRequests, pullRequestPort, redirects), ...pullRequestBody.map(body => sourcePart(pullRequests, body))],
  'workspace-pull-request-port')
  author.replace(pullRequestPort,
    'import { type ProviderChangeRequestWatchFingerprint } from "@t3tools/source-control-core/server/PullRequestProvider";',
    'import type { ProviderChangeRequestWatchFingerprint } from "@t3tools/source-control-core/server/PullRequestProvider";',
    'workspace-pr-provider-type-only')
  for (const body of pullRequestBody) {
    const names = exportedNames(body)
    const bindings = names.map(name => `${name === 'PullRequestService' ? '' : 'type '}${name}`).join(', ')
    author.replace(pullRequests, body,
      `import { ${bindings} } from "./PullRequestService.session-port.ts";\nexport { ${bindings} };\n`,
      `workspace-share-pull-request:${names.join('-')}`)
  }
  redirects.set(pullRequests, pullRequestPort)

  // Reuse the exact original checkpoint ref algorithm without importing its executing owner.
  const checkpoints = root + 'orchestration-v2/CheckpointService.ts'
  const reference = author.between(checkpoints, 'export const checkpointRefForScopeOrdinal =', 'function checkpointIdForScopeOrdinal(')
  const referenceTarget = checkpoints.replace('.ts', '.session-ref.ts')
  author.derive(referenceTarget, [selectedImports(author.read(checkpoints), reference, checkpoints, referenceTarget),
    sourcePart(checkpoints, 'const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints";\n'),
    sourcePart(checkpoints, reference)], 'workspace-checkpoint-ref')
  author.replace(checkpoints, reference,
    'import { checkpointRefForScopeOrdinal } from "./CheckpointService.session-ref.ts";\n'
      + 'export { checkpointRefForScopeOrdinal };\n\n', 'workspace-share-checkpoint-ref')
  redirects.set(checkpoints, referenceTarget)

  const processFile = root + 'vcs/VcsProcess.ts'
  const processConstants = processFile.replace('.ts', '.session-constants.ts')
  const locked = author.between(processFile, 'export const GIT_INDEX_LOCKED_DETAIL =',
    'export const CHECKPOINT_CAPTURE_OPERATION =')
  author.derive(processConstants, [sourcePart(processFile, locked)], 'workspace-git-lock-message')
  author.replace(processFile, locked,
    'import { GIT_INDEX_LOCKED_DETAIL } from "./VcsProcess.session-constants.ts";\n'
      + 'export { GIT_INDEX_LOCKED_DETAIL };\n\n', 'workspace-share-git-lock-message')

  // These original implementations have no process owner or filesystem default after redirection.
  for (const file of ['git/GitWorkflowService.ts', 'review/ReviewService.ts',
    'checkpointing/CheckpointStore.ts', 'checkpointing/CheckpointDiffQuery.ts', 'vcs/VcsProvisioningService.ts',
    'git/linkCreatedPullRequest.ts', 'git/refreshPushedPullRequests.ts', 'worktreesDirectory.ts',
    'orchestration-v2/CheckpointRollbackService.ts', 'orchestration-v2/CheckpointRollbackService.session-port.ts']) {
    const source = root + file
    const before = author.read(source)
    for (const [from, to] of redirects) {
      const fromName = from.slice(root.length)
      const toName = to.slice(root.length)
      // The rollback implementation needs the service tag, not the pure ref helper.
      const target = from === checkpoints && file.startsWith('orchestration-v2/CheckpointRollback')
        ? 'orchestration-v2/CheckpointService.session-port.ts'
        : file === 'checkpointing/CheckpointDiffQuery.ts'
          && fromName === 'orchestration-v2/ThreadManagementService.ts'
          ? 'orchestration-v2/ThreadReadsTag.ts' : toName
      const relative = path => {
        const value = posix.relative(posix.dirname(file), path)
        return value.startsWith('.') ? value : `./${value}`
      }
      const oldPath = relative(fromName)
      const newPath = relative(target)
      const oldImport = `from "${oldPath}"`
      if (before.includes(oldImport)) author.replace(source, oldImport, `from "${newPath}"`,
        `workspace-import:${file}:${fromName}`)
    }
    const processImport = 'from "../vcs/VcsProcess.ts"'
    if (file.startsWith('orchestration-v2/CheckpointRollback') && author.read(source).includes(processImport)) {
      author.replace(source, processImport, 'from "../vcs/VcsProcess.session-constants.ts"',
        `workspace-rollback-pure-lock-message:${file}`)
    }
  }
  author.replace(root + 'git/linkCreatedPullRequest.ts',
    'import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";',
    'import { builtInSourceControlDefinitions as sourceControlDefinitions } from "@t3tools/source-control-definitions/registry";',
    'workspace-pure-pr-definitions')
  // This namespace is used only in signatures. Keep its process implementation out of the runtime graph.
  author.replace(root + 'vcs/VcsDriver.ts', 'import * as VcsProcess from "./VcsProcess.ts";',
    'import type * as VcsProcess from "./VcsProcess.ts";', 'workspace-vcs-process-type-only')

  // Conversation-only rewind must not recreate a removed worktree or delete Git checkpoint refs.
  // Retain original provider rollback, shared-workspace checks and audit events unchanged.
  const rollback = root + 'orchestration-v2/CheckpointRollbackService.ts'
  author.replace(rollback, '      worktreePath != null &&\n',
    '      input.restoreFiles !== false &&\n      worktreePath != null &&\n', 'workspace-conversation-rewind-no-create')
  author.replace(rollback, '      if (staleCheckpoints.length > 0) {',
    '      if (input.restoreFiles !== false && staleCheckpoints.length > 0) {',
    'workspace-conversation-rewind-no-ref-delete')
  return { format: 1, sourceCommit: snapshot.identity.commit, patches: author.patches }
}
