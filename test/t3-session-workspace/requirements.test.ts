import assert from 'node:assert/strict'
import test from 'node:test'
import * as Schema from 'effect/Schema'
import { ExecutorT3Request } from '@nessie/executor-protocol/t3-session'
import { OrchestrationV2Command } from '@nessie/t3-session-source/contracts'
import { isWorkspaceRequest, workspaceOperations } from '../../src/t3-session/workspace/contracts.js'
import { workspaceCommandRequirements, workspaceRequirements } from '../../src/t3-session/workspace/requirements.js'

const routing = {
  transportVersion: 1, protocolVersion: 2,
  sourceRevision: '25bf84ab07f53f141c20239c63e383823a9d5ea0',
  executorId: '00000000-0000-4000-8000-000000000015', environmentId: 'original:environment/č',
  connectionEpoch: '17', runtimeGeneration: 'generation-1', correlationId: 'attempt-2', relayOrdinal: 3,
  kind: 'request',
}
const requirements = (method: string, input: unknown, commandId?: string) => {
  const request = Schema.decodeUnknownSync(ExecutorT3Request)({ ...routing, method, input,
    ...(commandId === undefined ? {} : { commandId }) })
  assert.ok(isWorkspaceRequest(request))
  return workspaceRequirements(request)
}

test('nested deferred diff and rename paths remain separate admission obligations', () => {
  const result = requirements('review.getDiffPreview', { cwd: 'C:\\repo', metadataOnly: false,
    file: { path: 'new/č file.ts', previousPath: '../other/old.ts', sourceKind: 'working-tree' } })
  assert.deepEqual(result.filter(item => item.kind === 'relative-file'), [
    { kind: 'relative-file', cwd: 'C:\\repo', path: 'new/č file.ts' },
    { kind: 'relative-file', cwd: 'C:\\repo', path: '../other/old.ts' },
  ])
  // Preserving a hostile path here is intentional: the held filesystem owner must reject it.
  assert.ok(result.some(item => item.kind === 'repository'))
})

test('generated worktree destinations and force removal never collapse into a cwd grant', () => {
  const create = requirements('vcs.createWorktree', { cwd: '/repo', refName: 'main', path: null }, 'create-1')
  assert.ok(create.some(item => item.kind === 'worktree' && item.intent === 'create' && item.path === null))
  const remove = requirements('vcs.removeWorktree', { cwd: '/repo', path: '/other-checkout', force: true }, 'remove-1')
  assert.ok(remove.some(item => item.kind === 'worktree' && item.intent === 'remove' && item.path === '/other-checkout'))
})

test('ref refresh requires a receipt even though ordinary ref listing is repeatable', () => {
  requirements('vcs.listRefs', { cwd: '/repo', refresh: false })
  assert.throws(() => requirements('vcs.listRefs', { cwd: '/repo', refresh: true }), /RECEIPT_REQUIRED/)
  requirements('vcs.listRefs', { cwd: '/repo', refresh: true }, 'refresh-1')
})

test('turn ranges retain original non-UUID thread IDs and original boundaries', () => {
  const result = requirements('orchestration.getTurnDiff', {
    threadId: 'old/thread:č', fromTurnCount: 7, toTurnCount: 12, ignoreWhitespace: false,
  })
  const range = result.find(item => item.kind === 'checkpoint-range')
  assert.deepEqual(range, { kind: 'checkpoint-range', input: {
    threadId: 'old/thread:č', fromTurnCount: 7, toTurnCount: 12, ignoreWhitespace: false,
  } })
})

test('conversation rewind retains its canonical command body', () => {
  const command = Schema.decodeUnknownSync(OrchestrationV2Command)({ type: 'checkpoint.rollback',
    commandId: 'rewind-1', threadId: 'source/thread', scopeId: 'original/scope',
    checkpointId: 'original/checkpoint', restoreFiles: false })
  assert.equal(command.type, 'checkpoint.rollback')
  if (command.type !== 'checkpoint.rollback') throw new Error('wrong command')
  const result = workspaceCommandRequirements(command)
  const last = result.at(-1)
  assert.ok(last?.kind === 'rewind')
  assert.equal(last.command, command)
  assert.equal(workspaceOperations['git.runStackedAction'].mode, 'stream')
  assert.equal(workspaceOperations['orchestration.getTurnDiff'].mode, 'finite')
})

test('linked PR watch keeps repository identity and uses the existing dispatch lane', () => {
  const command = Schema.decodeUnknownSync(OrchestrationV2Command)({ type: 'thread.pull-request.watch',
    commandId: 'watch-1', threadId: 'source/thread', host: 'github.com', repository: 'owner/repo', number: 15,
    watching: true })
  assert.ok(command.type === 'thread.pull-request.watch')
  const last = workspaceCommandRequirements(command).at(-1)
  assert.ok(last?.kind === 'pull-request')
  assert.equal(last.command, command)
})
