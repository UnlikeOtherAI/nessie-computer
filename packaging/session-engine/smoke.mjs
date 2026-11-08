import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const output = resolve(process.argv[2])
const bytes = await readFile(output)
const provenance = JSON.parse(await readFile(`${output}.provenance.json`, 'utf8'))
assert.equal(provenance.kind, 'session-engine-library')
assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.bundleSha256)
assert.equal(bytes.includes(Buffer.from('layerLegacyV1ThreadImporterNoop')), false)
assert.equal(Object.hasOwn(provenance.sourceInputs,
  'apps/server/src/orchestration-v2/ThreadManagementService.ts'), false)
let starts = 0
const constructors = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
const original = new Map(constructors.map(name => [name, childProcess[name]]))
for (const name of constructors) childProcess[name] = () => {
  starts++
  throw new Error('Library import/factory construction attempted to create a child process.')
}
syncBuiltinESMExports()
try {
  // Only this single qualified module is loaded; no separately bundled contracts/Effect candidate is combined with it.
  const engine = await import(pathToFileURL(output).href)
  assert.equal(engine.ORCHESTRATION_PROTOCOL_VERSION, 2)
  const state = engine.createSessionStateLayers()
  const reads = engine.createSessionReadLayers(state)
  const higher = engine.createSessionEngineLayers(state)
  assert.equal(reads.state, state)
  assert.equal(higher.state, state)
  assert.equal(state.outbox, engine.Outbox.layer)
  assert.equal(typeof engine.ThreadMessageIntake.dispatchCommand, 'function')
  assert.equal(typeof engine.ThreadMessageIntake.launchThread, 'function')
  assert.equal('layer' in engine.Threads, false)
  const coBuild = typeof engine.qualifySessionCoBuild === 'function' ? await engine.qualifySessionCoBuild() : undefined
  assert.equal(starts, 0)
  process.stdout.write(`${JSON.stringify({ bundleSha256: provenance.bundleSha256, protocol: 2,
    importsWithoutChildCreation: true, stateReferencesReused: true, originalIntakeExported: true,
    noNoopImporterExport: true, lifecycleReadinessClaimed: false,
    qualification: provenance.qualification, ...(coBuild ? { coBuild } : {}) })}\n`)
} finally {
  for (const [name, implementation] of original) childProcess[name] = implementation
  syncBuiltinESMExports()
}
