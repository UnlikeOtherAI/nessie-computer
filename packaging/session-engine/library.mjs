import { createHash } from 'node:crypto'
import { isBuiltin } from 'node:module'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, version as bundler } from 'esbuild'
import { sessionDependencyNotices } from './build.mjs'
import { prepareSessionEngineSnapshot } from './engine-snapshot.mjs'
import { assertSessionEngineSourceGraph } from './graph.mjs'
import { lintSessionEngineSources } from './lint.mjs'
import { sessionEngineSourcePlugin } from './resolver.mjs'
import { typecheckSessionState } from './typecheck.mjs'
import { clientSourceManifest, readClientSourceInputs } from './client-source.mjs'
import { selectMobileClientSource } from './client-selection.mjs'
import { assertBrowserClientGraph } from './client-graph.mjs'

const tools = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(tools, '../..')
const slash = path => path.replaceAll('\\', '/')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const externalPackages = ['effect', '@effect/platform-node', '@effect/platform-node-shared', '@noble/hashes']
const external = name => externalPackages.some(pkg => name === pkg || name.startsWith(`${pkg}/`))

export const prepareLibrarySnapshot = async (original, { sourceRepository } = {}) => {
  const registration = JSON.parse(await readFile(new URL('./library-inputs.json', import.meta.url), 'utf8'))
  const privacy = await readFile(new URL('../../patches/t3-session/requests/boundary-patches.json', import.meta.url))
  const workspace = await readFile(new URL('../../patches/t3-session/workspace/boundary-patches.json', import.meta.url))
  if (registration.format !== 1 || hash(privacy) !== registration.privacyManifestSha256) {
    throw new Error('SESSION_ENGINE_LIBRARY_PRIVACY_IDENTITY_MISMATCH')
  }
  const contracts = await readFile(resolve(root, 'packages/t3-session-source/input.mjs'))
  if (hash(contracts) !== registration.contractsInputSha256) {
    throw new Error('SESSION_ENGINE_LIBRARY_CONTRACTS_IDENTITY_MISMATCH')
  }
  const prepared = prepareSessionEngineSnapshot(original,
    { additionalPatchFamilies: [{ id: 'request-privacy', bytes: privacy },
      { id: 'workspace', bytes: workspace }] })
  const { default: ts } = await import('typescript')
  const supplemented = await readClientSourceInputs(prepared.snapshot, sourceRepository)
  const selected = selectMobileClientSource(ts, supplemented, clientSourceManifest)
  return { ...prepared, snapshot: selected.snapshot, mobileClientSelection: selected.records, registration }
}

/** Exact authored files only: future adapters must register their complete imported closure here. */
export const assertLibraryAuthoredInputs = (inputs, registration) => {
  if (registration.entryPoint !== 'packaging/session-engine/core/Engine.ts'
    || !Array.isArray(registration.authoredInputs)
    || new Set(registration.authoredInputs).size !== registration.authoredInputs.length
    || registration.authoredInputs.some(path => !/^[a-zA-Z0-9_./-]+$/u.test(path)
      || path.split('/').some(part => !part || part === '..' || part === '.') || !path.endsWith('.ts'))) {
    throw new Error('SESSION_ENGINE_LIBRARY_REGISTRATION_INVALID')
  }
  if (inputs.some(path => !registration.authoredInputs.includes(path))) {
    throw new Error('SESSION_ENGINE_LIBRARY_AUTHORED_INPUT_REFUSED')
  }
}

/** One snapshot and split graph. Effect is a normal package dependency, never embedded. */
export const buildSessionPackage = async ({ original, prepared, outputDirectory,
  contractsAliasPlugin, check = false }) => {
  await lintSessionEngineSources()
  const { snapshot, registration, manifestBytes } = prepared
  const entry = resolve(root, registration.entryPoint)
  if (registration.clientEntryPoint !== 'packaging/session-engine/core/Client.ts') {
    throw new Error('SESSION_CLIENT_ENTRY_REGISTRATION_INVALID')
  }
  const clientEntry = resolve(root, registration.clientEntryPoint)
  assertLibraryAuthoredInputs([registration.entryPoint, registration.clientEntryPoint], registration)
  const typecheck = await typecheckSessionState(snapshot, entry,
    { additionalEntries: { client: clientEntry },
      ...(check ? {} : { declarationDirectory: resolve(outputDirectory, 'engine-types'), sharedContracts: true }),
      assertAuthoredInputs: paths => assertLibraryAuthoredInputs(paths, registration) })
  if (check) return { typecheck }
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  const result = await build({
    absWorkingDir: tools,
    entryPoints: { engine: entry, client: clientEntry, contracts: 't3-source:packages/contracts/src/index.ts',
      settings: 't3-source:packages/contracts/src/settings.ts', relay: 't3-source:packages/contracts/src/relay.ts' },
    outdir: outputDirectory, splitting: true, bundle: true, format: 'esm', platform: 'node', target: 'node22.16',
    external: externalPackages.flatMap(name => [name, `${name}/*`]),
    legalComments: 'eof', metafile: true, write: false,
    plugins: [contractsAliasPlugin({ dependencyDirectory: tools }), sessionEngineSourcePlugin({
      snapshot, dependencyDirectory: tools, dependencies: Object.keys(manifest.dependencies),
    })],
  })
  const clientGraph = assertBrowserClientGraph(result.metafile)
  const inputs = Object.keys(result.metafile.inputs)
  const sourceInputs = inputs.filter(path => path.startsWith('nessie-t3-source:'))
    .map(path => path.slice('nessie-t3-source:'.length)).sort()
  assertSessionEngineSourceGraph(sourceInputs)
  const authored = inputs.filter(path => !path.startsWith('nessie-t3-source:') && !path.startsWith('node_modules/'))
    .map(path => slash(relative(root, resolve(tools, path)))).sort()
  assertLibraryAuthoredInputs(authored, registration)
  const dependencies = inputs.filter(path => path.startsWith('node_modules/')).sort()
  if (dependencies.some(path => /(?:^|\/)effect(?:@[^/]+)?\//u.test(path) || path.includes('/@effect/'))) {
    throw new Error('SESSION_ENGINE_LIBRARY_EMBEDDED_EFFECT_REFUSED')
  }
  for (const output of Object.values(result.metafile.outputs)) for (const imported of output.imports) {
    if (imported.external && !isBuiltin(imported.path) && !external(imported.path)) {
      throw new Error('SESSION_ENGINE_LIBRARY_EXTERNAL_REFUSED')
    }
  }
  const modules = []
  for (const output of result.outputFiles) {
    await writeFile(output.path, output.contents)
    modules.push({ path: slash(relative(outputDirectory, output.path)), sha256: hash(output.contents),
      bytes: output.contents.length })
  }
  modules.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const notices = { upstream: { ...snapshot.identity, license: snapshot.read('LICENSE').toString('utf8') },
    dependencies: await sessionDependencyNotices([...dependencies,
      ...externalPackages.map(name => `node_modules/${name}/package.json`)]) }
  const producer = (await readdir(tools))
    .filter(path => path.endsWith('.mjs') || ['library-inputs.json', 'client-source.json'].includes(path)).sort()
  const hashes = async (paths, directory) => Object.fromEntries(await Promise.all(paths.map(async path =>
    [path, hash(await readFile(resolve(directory, path)))])))
  const provenance = {
    format: 1, kind: 'session-engine-package', sourceIdentity: snapshot.identity,
    qualification: { distributableLibrary: true, syntheticProofs: false, installedRuntime: false,
      providerExecution: false, canonicalVaultBroker: false },
    registration, typecheck, clientGraph, mobileClientSelection: prepared.mobileClientSelection,
    bundler, node: process.versions.node,
    dependencyLockSha256: hash(await readFile(new URL('./pnpm-lock.yaml', import.meta.url))),
    buildManifestSha256: hash(await readFile(new URL('./package.json', import.meta.url))),
    sourceInputs: Object.fromEntries(sourceInputs.map(path => [path, hash(snapshot.read(path))])),
    originalSourceInputs: Object.fromEntries(sourceInputs.filter(path => original.files.includes(path))
      .map(path => [path, hash(original.read(path))])),
    authoredInputs: await hashes(authored, root), dependencyInputs: await hashes(dependencies, tools),
    producerInputs: await hashes(producer, tools),
    sharedContractTypes: await hashes((await readdir(resolve(outputDirectory, 'source'))).sort()
      .map(path => `source/${path}`), outputDirectory),
    externalDependencies: notices.dependencies.filter(({ name }) => externalPackages.includes(name)),
    modules, modulesSha256: hash(JSON.stringify(modules)),
    licensesSha256: hash(`${JSON.stringify(notices, null, 2)}\n`),
  }
  await writeFile(resolve(outputDirectory, 'engine.patches.json'), manifestBytes)
  await writeFile(resolve(outputDirectory, 'engine.licenses.json'), `${JSON.stringify(notices, null, 2)}\n`)
  await writeFile(resolve(outputDirectory, 'engine.provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
  return { result, provenance }
}
