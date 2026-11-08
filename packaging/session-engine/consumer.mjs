import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tools = fileURLToPath(new URL('.', import.meta.url))
const output = resolve(process.argv[2])
const provenance = JSON.parse(await readFile(`${output}.provenance.json`, 'utf8'))
if (provenance.kind !== 'session-engine-library') throw new Error('Consumer proof requires an engine library candidate.')
const declarations = `${output}.declarations`
for (const [file, expected] of Object.entries(provenance.typecheck.declarations.files)) {
  const actual = createHash('sha256').update(await readFile(resolve(declarations, file))).digest('hex')
  if (actual !== expected) throw new Error('Declaration provenance mismatch.')
}
const fixture = `${output}.consumer.ts`
let module = relative(dirname(fixture), resolve(declarations, 'index.js')).replaceAll('\\', '/')
if (!module.startsWith('.')) module = `./${module}`
const content = `import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import { createSessionReadLayers, createSessionEngineLayers, ProviderSessions, ResourceOwners, Settings,
  ProjectionStore, EventSink,
  ThreadMessageIntake, SecretRequests } from '${module}'
type Input<T> = T extends Layer.Layer<infer _Out, infer _Error, infer Required> ? Required : never
type Reads = Input<ReturnType<typeof createSessionReadLayers>['layer']>
type Engine = Input<ReturnType<typeof createSessionEngineLayers>['layer']>
type Worker = Input<ReturnType<typeof createSessionEngineLayers>['worker']>
type Shared = Input<ReturnType<typeof createSessionEngineLayers>['shared']>
const readSqlRequired: SqlClient.SqlClient extends Reads ? true : false = true
const readProviderRequired: ProviderSessions.ProviderSessionManagerV2 extends Reads ? true : false = false
const engineProviderRequired: ProviderSessions.ProviderSessionManagerV2 extends Engine ? true : false = true
const engineSettingsRequired: Settings.ServerSettingsService extends Engine ? true : false = true
const workerCleanupRequired: ResourceOwners.ResourceCleanupService extends Worker ? true : false = true
const sharedSqlRequired: SqlClient.SqlClient extends Shared ? true : false = true
const sharedProjectionRequired: ProjectionStore.ProjectionStoreV2 extends Shared ? true : false = false
const engineEventSinkRequired: EventSink.EventSinkV2 extends Engine ? true : false = false
type Command = Parameters<typeof ThreadMessageIntake.dispatchCommand>[0]
// @ts-expect-error Original source command discriminants must survive the generated boundary.
const invalidCommand: Command = { type: 'invented-command' }
type SecretAnswer = Parameters<SecretRequests.SecretRequests['Service']['answer']>[0]
// @ts-expect-error A plain value cannot substitute for the original dedicated request schema.
const invalidSecret: SecretAnswer = { value: 'synthetic-only' }
void [readSqlRequired, readProviderRequired, engineProviderRequired, engineSettingsRequired, workerCleanupRequired,
  sharedSqlRequired, sharedProjectionRequired, engineEventSinkRequired, invalidCommand, invalidSecret]
`
const existing = await readFile(fixture, 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error
  return undefined
})
if (existing !== undefined && existing !== content) throw new Error('Consumer fixture output conflict.')
if (existing === undefined) await writeFile(fixture, content, { flag: 'wx' })
// Ordinary tsc and package resolution: no source resolver, paths aliases, custom compiler host or runtime loader.
const modes = [['ESNext', 'Bundler'], ['NodeNext', 'NodeNext']]
for (const [module, resolution] of modes) {
  const result = spawnSync(process.execPath, [resolve(tools, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes',
    '--target', 'ESNext', '--module', module, '--moduleResolution', resolution,
    '--allowImportingTsExtensions', '--resolveJsonModule', '--types', 'node', fixture,
  ], { cwd: tools, windowsHide: true, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error(`Normal ${resolution} TypeScript consumer proof failed.`)
}
process.stdout.write(`${JSON.stringify({ compiler: provenance.typecheck.compiler, normalModuleResolution: true,
  declarationFiles: Object.keys(provenance.typecheck.declarations.files).length,
  declarationsSha256: provenance.typecheck.declarations.sha256, dependencyDirectory: 'packaging/session-engine',
  effect: '4.1.2', libraryChecks: true, moduleResolutionModes: modes.map(([, mode]) => mode),
  providerAndCleanupPortsRequired: true })}\n`)
