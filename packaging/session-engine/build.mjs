import { createHash } from 'node:crypto'
import { isBuiltin } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { prepareSessionEngineSource, SessionEngineSourceError } from './source.mjs'
import { readSessionEngineSnapshot } from './snapshot.mjs'
import { sessionEngineSourcePlugin, sessionEngineMetafileSourcePath } from './resolver.mjs'
import { typecheckSessionState } from './typecheck.mjs'
import { applySessionEngineBoundaryPatches } from './patches.mjs'
import { prepareSessionEngineSnapshot } from './engine-snapshot.mjs'
import { lintSessionEngineSources } from './lint.mjs'
import { assertSessionEngineSourceGraph } from './graph.mjs'

const tools = fileURLToPath(new URL('.', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

// This exact npm release omits its monorepo's license from the tarball.
// Keep the release's actual upstream notice, rather than substituting SPDX text.
const pinnedDependencyNotices = {
  'remark-math@6.0.0': {
    repository: 'https://github.com/remarkjs/remark-math',
    commit: 'd5d0660b150810a535bbb07eac6cc96a4510aa24', path: 'license',
    packageIntegrity: 'sha512-MMqgnP74Igy+S3WwnhQ7kqGlEerTETXMvJhrUzDikVZ2/uogJCb+WHUg97hK9/jcfc0dkD73s3LN8zU49cTEtA==',
    sha256: 'cb992262f361a5359e6771c28740d33c7041e15332ae8537fae40538992591a9',
    localFile: 'notices/remark-math-6.0.0.LICENSE', license: 'MIT',
  },
}

const writeImmutable = async (path, bytes) => {
  const existing = await readFile(path).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (existing) {
    if (hash(existing) !== hash(bytes)) throw new SessionEngineSourceError('SESSION_ENGINE_BUILD_OUTPUT_CONFLICT')
    return
  }
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
}

export const sessionDependencyNotices = async inputs => {
  const packages = new Map()
  let effectRoot
  for (const input of inputs) {
    if (!input.includes('node_modules/')) continue
    let directory = dirname(resolve(tools, input))
    while (directory !== dirname(directory)) {
      const manifest = await readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => undefined)
      if (manifest?.name) {
        if (manifest.name === 'effect') {
          if (manifest.version !== '4.1.2' || effectRoot && effectRoot !== directory) {
            throw new SessionEngineSourceError('SESSION_ENGINE_EFFECT_SINGLETON_REFUSED')
          }
          effectRoot = directory
        }
        if (!packages.has(manifest.name)) {
          let notice
          let noticeSource
          const files = (await readdir(directory)).sort()
          for (const expected of ['license', 'license.md', 'license.txt', 'license-mit', 'licence']) {
            const name = files.find(file => file.toLowerCase() === expected)
            if (!name) continue
            notice = await readFile(resolve(directory, name), 'utf8').catch(() => undefined)
            if (notice) break
          }
          if (!notice) {
            const pinned = pinnedDependencyNotices[`${manifest.name}@${manifest.version}`]
            if (pinned && manifest.license === pinned.license) {
              const bytes = await readFile(resolve(tools, pinned.localFile))
              const lock = await readFile(resolve(tools, 'pnpm-lock.yaml'), 'utf8')
              if (hash(bytes) !== pinned.sha256 || !lock.includes(`integrity: ${pinned.packageIntegrity}`)) {
                throw new SessionEngineSourceError('SESSION_ENGINE_DEPENDENCY_LICENSE_IDENTITY_MISMATCH')
              }
              notice = bytes.toString('utf8')
              noticeSource = pinned
            }
          }
          if (!notice) throw new SessionEngineSourceError('SESSION_ENGINE_DEPENDENCY_LICENSE_ABSENT')
          packages.set(manifest.name, {
            name: manifest.name, version: manifest.version, license: manifest.license, notice,
            ...(noticeSource ? { noticeSource } : {}),
          })
        }
        break
      }
      directory = dirname(directory)
    }
  }
  return [...packages.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}

/** Offline after a frozen dependency install; emits a dependency-closed library, not an installed runtime. */
const buildSessionModule = async ({ sourceRepository, outputPath, proof = false, engine = false,
  entryPoint, additionalPatchFamilies, contractsAliasPlugin }) => {
  await lintSessionEngineSources()
  const output = resolve(outputPath)
  await mkdir(dirname(output), { recursive: true })
  const prepared = await prepareSessionEngineSource({ sourceRepository, archivePath: `${output}.source.tar` })
  const source = {
    commit: prepared.commit, tree: prepared.tree, sourceFiles: prepared.sourceFiles,
    archiveSha256: prepared.archiveSha256, archiveBytes: prepared.archiveBytes,
  }
  const original = await readSessionEngineSnapshot(`${output}.source.tar`)
  const preparedEngine = engine ? prepareSessionEngineSnapshot(original, { additionalPatchFamilies }) : undefined
  const snapshot = preparedEngine?.snapshot ?? applySessionEngineBoundaryPatches(original)
  const entry = entryPoint ? resolve(entryPoint)
    : resolve(tools, engine ? proof ? 'core/HistoryProof.ts' : 'core/Engine.ts'
      : proof ? 'core/StateProof.ts' : 'core/StateLayers.ts')
  const typecheck = await typecheckSessionState(snapshot, entry,
    engine ? { declarationDirectory: `${output}.declarations` } : {})
  const manifest = JSON.parse(await readFile(resolve(tools, 'package.json'), 'utf8'))
  const { build, version: bundler } = await import('esbuild')
  const result = await build({
    absWorkingDir: tools, entryPoints: [entry], outfile: output, write: false,
    bundle: true, format: 'esm', platform: 'node', target: 'node22.16', metafile: true,
    plugins: [...(contractsAliasPlugin ? [contractsAliasPlugin({ dependencyDirectory: tools })] : []),
      sessionEngineSourcePlugin({
      snapshot, dependencyDirectory: tools, dependencies: Object.keys(manifest.dependencies),
    })],
  })
  const inputs = Object.keys(result.metafile.inputs)
  const sourceInputs = [...new Set(inputs.map(input => sessionEngineMetafileSourcePath(input, snapshot))
    .filter(path => path !== undefined))].sort()
  assertSessionEngineSourceGraph(sourceInputs)
  for (const input of inputs.filter(input => !input.startsWith('nessie-t3-source:'))) {
    const path = relative(tools, resolve(tools, input)).replaceAll('\\', '/')
    const authored = relative(resolve(tools, '../..'), resolve(tools, input)).replaceAll('\\', '/')
    const coBuild = engine && authored.startsWith('packages/t3-session-source/src/')
    if (!coBuild && (path.startsWith('../') || !path.startsWith('core/') && !path.startsWith('node_modules/'))) {
      throw new SessionEngineSourceError('SESSION_ENGINE_BUILD_INPUT_REFUSED')
    }
  }
  for (const output of Object.values(result.metafile.outputs)) for (const imported of output.imports) {
    if (imported.external && !isBuiltin(imported.path)) {
      throw new SessionEngineSourceError('SESSION_ENGINE_EXTERNAL_RUNTIME_DEPENDENCY')
    }
  }
  const bytes = result.outputFiles[0].contents
  const notices = {
    upstream: { ...snapshot.identity, license: snapshot.read('LICENSE').toString('utf8') },
    dependencies: await sessionDependencyNotices(inputs),
  }
  const provenance = {
    format: 1, kind: engine ? proof ? 'synthetic-history-proof' : 'session-engine-library'
      : proof ? 'synthetic-state-proof' : 'session-state-library',
    source, sourceIdentity: snapshot.identity, bundleSha256: hash(bytes), bundleBytes: bytes.length,
    dependencyLockSha256: hash(await readFile(resolve(tools, 'pnpm-lock.yaml'))),
    buildManifestSha256: hash(await readFile(resolve(tools, 'package.json'))),
    node: process.versions.node, typecheck, bundler,
    qualification: { entryPoint: relative(resolve(tools, '../..'), entry).replaceAll('\\', '/'),
      distributable: false, includesSyntheticHistoryProof: entry === resolve(tools, 'core/CoBuildProof.ts')
        || engine && proof },
    sourceInputs: Object.fromEntries(sourceInputs.map(file => [file, hash(snapshot.read(file))])),
    originalSourceInputs: Object.fromEntries(sourceInputs.filter(file => original.files.includes(file))
      .map(file => [file, hash(original.read(file))])),
    derivedSourceInputs: sourceInputs.filter(file => !original.files.includes(file)),
    authoredInputs: Object.fromEntries(await Promise.all(inputs.filter(input => !input.startsWith('node_modules/')
      && !input.startsWith('nessie-t3-source:')).map(async file => [
      relative(resolve(tools, '../..'), resolve(tools, file)).replaceAll('\\', '/'),
      hash(await readFile(resolve(tools, file))),
    ]))),
    dependencyInputs: Object.fromEntries(await Promise.all(inputs.filter(input => input.startsWith('node_modules/'))
      .map(async file => [file, hash(await readFile(resolve(tools, file)))]))),
    dependencies: notices.dependencies.map(({ name, version, license }) => ({ name, version, license })),
    producerInputs: Object.fromEntries(await Promise.all((await readdir(tools)).filter(file => file.endsWith('.mjs'))
      .map(async file => [`packaging/session-engine/${file}`, hash(await readFile(resolve(tools, file)))]))),
  }
  if (preparedEngine) await writeImmutable(`${output}.patches.json`, preparedEngine.manifestBytes)
  await writeImmutable(`${output}.licenses.json`, `${JSON.stringify(notices, null, 2)}\n`)
  await writeImmutable(output, bytes)
  await writeImmutable(`${output}.provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`)
  return {
    bundleSha256: provenance.bundleSha256, bundleBytes: bytes.length,
    sourceModules: sourceInputs.length, node: provenance.node,
    typecheck: { ...typecheck, ...(typecheck.declarations ? { declarations: {
      entry: typecheck.declarations.entry, upstream: typecheck.declarations.upstream,
      files: Object.keys(typecheck.declarations.files).length, sha256: typecheck.declarations.sha256,
    } } : {}) }, bundler,
  }
}

export const buildSessionStateModule = options => buildSessionModule(options)

/** T01 may supply its source-only entry. The co-build shares one resolver, patch tuple, root and Effect singleton. */
export const buildSessionEngineModule = options => buildSessionModule({ ...options, engine: true })

const main = async args => {
  const proof = args.includes('--proof')
  const engine = args.includes('--engine')
  const positional = args.filter(argument => argument !== '--proof' && argument !== '--engine')
  if (positional.length !== 4 || positional[0] !== '--source' || positional[2] !== '--output') {
    throw new SessionEngineSourceError('Usage: node build.mjs --source <pinned Git repository> --output <new module.mjs> [--proof]')
  }
  const build = engine ? buildSessionEngineModule : buildSessionStateModule
  process.stdout.write(`${JSON.stringify(await build({ sourceRepository: positional[1], outputPath: positional[3], proof }))}\n`)
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof SessionEngineSourceError ? error.code : error.message}\n`)
    process.exitCode = 1
  })
}
