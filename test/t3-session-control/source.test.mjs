import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { T3_SESSION_ENGINE_SOURCE, verifySessionEngineSource } from '../../packaging/session-engine/source.mjs'
import { prepareSessionEngineSnapshot } from '../../packaging/session-engine/engine-snapshot.mjs'
import { applySessionEngineBoundaryPatches } from '../../packaging/session-engine/patches.mjs'
import { generateSessionControlManifest } from '../../patches/t3-session/session-control/index.mjs'

const repository = process.env.T3_SESSION_CONTROL_REFERENCE
assert.ok(repository, 'Set T3_SESSION_CONTROL_REFERENCE to a repository containing the pinned source.')
const identity = await verifySessionEngineSource(repository)
const read = path => execFileSync('git', ['--no-replace-objects', '-C', repository,
  'show', `${identity.commit}:${path}`], { maxBuffer: 4 * 1024 * 1024, windowsHide: true })
const files = execFileSync('git', ['--no-replace-objects', '-C', repository,
  'ls-tree', '-r', '--name-only', identity.commit, '--', ...T3_SESSION_ENGINE_SOURCE.roots],
{ encoding: 'utf8', windowsHide: true }).trim().split('\n')
const original = { identity, files, read }
const before = prepareSessionEngineSnapshot(original, { includeSessionControl: false }).snapshot
const bytes = readFileSync(new URL('../../patches/t3-session/session-control/boundary-patches.json', import.meta.url))
const manifest = JSON.parse(bytes)
const prepared = prepareSessionEngineSnapshot(original)

test('control extraction reproduces exact committed ranges at the pinned source, with prior-stage hashes', () => {
  assert.deepEqual(generateSessionControlManifest(before), manifest)
  assert.equal(manifest.patches.length, 7)
  const dispatch = manifest.patches[0].create.filter(part => part.sourceFile)
  assert.equal(dispatch.length, 4)
  assert.ok(dispatch.every(part => part.sourceStage === 'current' && part.sourceSha256))
  for (const path of ['apps/server/src/orchestration-v2/SessionControl.ts',
    'apps/server/src/scheduledTasks/ScheduledTaskService.session-port.ts']) {
    assert.doesNotThrow(() => stripTypeScriptTypes(prepared.snapshot.read(path).toString()))
  }
})

test('the derived writer retains original retry/intake/wire projection and excludes startup and analytics', () => {
  const source = prepared.snapshot.read('apps/server/src/orchestration-v2/SessionControl.ts').toString()
  assert.match(source, /threadLaunch\.retryPreparation\(command\)/u)
  assert.match(source, /ThreadMessageIntake\.dispatchCommand/u)
  assert.match(source, /ThreadMessageIntake\.launchThread/u)
  assert.match(source, /projectThreadProjectionForWire\(result\.projection\)/u)
  assert.match(source, /userFacingDispatchErrorMessage\(cause\)/u)
  assert.equal((source.match(/\.\.\.provenance/gu) ?? []).length, 2)
  assert.doesNotMatch(source, /runServer|enqueueCommand|analytics|recordClientCommand|ServerRuntimeStartup/u)
  const schedule = prepared.snapshot.read('apps/server/src/scheduledTasks/ScheduledTaskService.session-port.ts').toString()
  assert.doesNotMatch(schedule, /const make|export const layer|webhook_secret|Metric\.|Scheduler\./u)
  assert.match(schedule, /t3\/scheduledTasks\/ScheduledTaskService/u)
})

test('one ordered manifest includes controls and privacy; a changed source range is refused', () => {
  const privacy = readFileSync(new URL('../../patches/t3-session/requests/boundary-patches.json', import.meta.url))
  const combined = prepareSessionEngineSnapshot(original,
    { additionalPatchFamilies: [{ id: 'request-privacy', bytes: privacy }] })
  assert.deepEqual(JSON.parse(combined.manifestBytes).families.map(row => row.id),
    ['state', 'client-connection', 'extraction', 'session-control', 'request-privacy'])
  const invalid = JSON.parse(prepared.manifestBytes)
  invalid.patches.find(row => row.id === 'extract-session-control').create.find(row => row.sourceFile).sha256 = '0'.repeat(64)
  assert.throws(() => applySessionEngineBoundaryPatches(original, Buffer.from(JSON.stringify(invalid))),
    /SESSION_ENGINE_BOUNDARY_PATCH_SOURCE_MISMATCH/u)
})
