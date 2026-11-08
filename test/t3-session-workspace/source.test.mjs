import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { generateWorkspaceManifest } from '../../patches/t3-session/workspace/generate.mjs'
import { applySessionEngineBoundaryPatches } from '../../packaging/session-engine/patches.mjs'
import { sourceSnapshot } from './source-fixture.mjs'

const baseline = sourceSnapshot()
const manifestBytes = readFileSync(new URL('../../patches/t3-session/workspace/boundary-patches.json', import.meta.url))
const manifest = JSON.parse(manifestBytes)
const patched = applySessionEngineBoundaryPatches(baseline, manifestBytes)

test('workspace manifest reproduces exact pinned source transformations', () => {
  assert.deepEqual(generateWorkspaceManifest(baseline), manifest)
  const drift = { ...baseline, read: file => file.endsWith('/ReviewService.ts')
    ? Buffer.concat([baseline.read(file), Buffer.from('\n// altered\n')]) : baseline.read(file) }
  assert.throws(() => applySessionEngineBoundaryPatches(drift, manifestBytes), /SOURCE_MISMATCH/)
})

test('original Git, review, checkpoint diff and provisioning implementations retain their bodies', () => {
  for (const file of ['git/GitWorkflowService.ts', 'review/ReviewService.ts',
    'checkpointing/CheckpointStore.ts', 'checkpointing/CheckpointDiffQuery.ts', 'vcs/VcsProvisioningService.ts']) {
    const path = `apps/server/src/${file}`
    const body = source => source.read(path).toString().split('export const make =')[1]
    assert.ok(body(baseline), path)
    assert.equal(body(patched), body(baseline), path)
  }
})

test('conversation-only rewind cannot recreate worktrees or delete checkpoint refs', () => {
  const file = 'apps/server/src/orchestration-v2/CheckpointRollbackService.ts'
  const source = patched.read(file).toString()
  assert.match(source, /input\.restoreFiles !== false &&\n\s+worktreePath != null &&/)
  assert.match(source, /if \(input\.restoreFiles !== false && staleCheckpoints\.length > 0\)/)
  assert.match(source, /if \(input\.restoreFiles !== false\) yield\* checkpoints\.restore/)
  const original = baseline.read(file).toString()
  assert.equal(source.replace('      input.restoreFiles !== false &&\n', '')
    .replace('input.restoreFiles !== false && staleCheckpoints.length > 0', 'staleCheckpoints.length > 0')
    .split('export const layer:')[1], original.split('export const layer:')[1])
})

test('workspace ports share original tags without live defaults or server startup', () => {
  for (const file of ['vcs/VcsDriverRegistry', 'vcs/VcsStatusBroadcaster',
    'workspace/KnownWorkspaces', 'pullRequest/PullRequestService']) {
    const port = patched.read(`apps/server/src/${file}.session-port.ts`).toString()
    assert.match(port, /extends Context\.Service/)
    assert.doesNotMatch(port, /export const (?:make|layer) =|defaultValue|runServer|child_process|ProcessRunner/)
    assert.ok(baseline.read(`apps/server/src/${file}.ts`).toString()
      .includes(port.match(/>\(\)\("([^"]+)"\)/)?.[1] ?? 'INVALID-TAG'))
  }
  const linked = patched.read('apps/server/src/git/linkCreatedPullRequest.ts').toString()
  assert.match(linked, /source-control-definitions\/registry/)
  assert.doesNotMatch(linked, /sourceControl\/sourceControlDefinitions\.ts/)
})
