import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { prepareSessionEngineSource, SessionEngineSourceError } from './source.mjs'
import { readSessionEngineSnapshot } from './snapshot.mjs'
import { sessionEngineSourcePlugin } from './resolver.mjs'
import { typecheckSessionState } from './typecheck.mjs'
import { applySessionEngineBoundaryPatches } from './patches.mjs'

const tools = fileURLToPath(new URL('.', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
const excluded = [
  /^apps\/server\/src\/(?:server\.ts|ws\.ts|bin[^/]*\.ts|auth\/|telemetry\/|preview\/|device\/)/u,
  /^apps\/server\/src\/provider\/(?:Drivers\/|ProviderHostLive\.ts|ProviderCredentialStore\.ts)/u,
  /^packages\/source-control-[^/]+\/src\/server\//u,
]

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

const lintOwnSources = async () => {
  const files = [
    ...(await readdir(tools)).filter(file => file.endsWith('.mjs')),
    ...(await readdir(resolve(tools, 'core'))).filter(file => file.endsWith('.ts')).map(file => `core/${file}`),
  ]
  const result = spawnSync(process.execPath, [
    resolve(tools, 'node_modules/eslint/bin/eslint.js'), '--config', 'eslint.config.mjs', '--max-warnings', '0', ...files,
  ], { cwd: tools, stdio: 'inherit', windowsHide: true })
  if (result.error || result.status !== 0) throw new SessionEngineSourceError('SESSION_ENGINE_BUILD_LINT_FAILED')
}

const dependencyNotices = async inputs => {
  const packages = new Map()
  for (const input of inputs) {
    if (!input.includes('node_modules/')) continue
    let directory = dirname(resolve(tools, input))
    while (directory !== dirname(directory)) {
      const manifest = await readFile(resolve(directory, 'package.json'), 'utf8').then(JSON.parse).catch(() => undefined)
      if (manifest?.name) {
        if (!packages.has(manifest.name)) {
          let notice
          for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENCE']) {
            notice = await readFile(resolve(directory, name), 'utf8').catch(() => undefined)
            if (notice) break
          }
          if (!notice) throw new SessionEngineSourceError('SESSION_ENGINE_DEPENDENCY_LICENSE_ABSENT')
          packages.set(manifest.name, {
            name: manifest.name, version: manifest.version, license: manifest.license, notice,
          })
        }
        break
      }
      directory = dirname(directory)
    }
  }
  return [...packages.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** Offline after a frozen dependency install; emits a dependency-closed library, not an installed runtime. */
export const buildSessionStateModule = async ({ sourceRepository, outputPath, proof = false }) => {
  await lintOwnSources()
  const output = resolve(outputPath)
  await mkdir(dirname(output), { recursive: true })
  const prepared = await prepareSessionEngineSource({ sourceRepository, archivePath: `${output}.source.tar` })
  const source = {
    commit: prepared.commit, tree: prepared.tree, sourceFiles: prepared.sourceFiles,
    archiveSha256: prepared.archiveSha256, archiveBytes: prepared.archiveBytes,
  }
  const original = await readSessionEngineSnapshot(`${output}.source.tar`)
  const snapshot = applySessionEngineBoundaryPatches(original)
  const entryPoint = resolve(tools, proof ? 'core/StateProof.ts' : 'core/StateLayers.ts')
  const typecheck = await typecheckSessionState(snapshot, entryPoint)
  const manifest = JSON.parse(await readFile(resolve(tools, 'package.json'), 'utf8'))
  const { build, version: bundler } = await import('esbuild')
  const result = await build({
    absWorkingDir: tools, entryPoints: [entryPoint], outfile: output, write: false,
    bundle: true, format: 'esm', platform: 'node', target: 'node22.16', metafile: true,
    plugins: [sessionEngineSourcePlugin({
      snapshot, dependencyDirectory: tools, dependencies: Object.keys(manifest.dependencies),
    })],
  })
  const inputs = Object.keys(result.metafile.inputs)
  const sourceInputs = inputs.filter(input => input.startsWith('nessie-t3-source:'))
    .map(input => input.slice('nessie-t3-source:'.length)).sort()
  if (sourceInputs.some(input => excluded.some(pattern => pattern.test(input)))) {
    throw new SessionEngineSourceError('SESSION_ENGINE_AGGREGATE_REFUSED')
  }
  for (const input of inputs.filter(input => !input.startsWith('nessie-t3-source:'))) {
    const path = relative(tools, resolve(tools, input)).replaceAll('\\', '/')
    if (path.startsWith('../') || !path.startsWith('core/') && !path.startsWith('node_modules/')) {
      throw new SessionEngineSourceError('SESSION_ENGINE_BUILD_INPUT_REFUSED')
    }
  }
  for (const output of Object.values(result.metafile.outputs)) for (const imported of output.imports) {
    if (imported.external && !builtins.has(imported.path)) throw new SessionEngineSourceError('SESSION_ENGINE_EXTERNAL_RUNTIME_DEPENDENCY')
  }
  const bytes = result.outputFiles[0].contents
  const notices = {
    upstream: { ...snapshot.identity, license: snapshot.read('LICENSE').toString('utf8') },
    dependencies: await dependencyNotices(inputs),
  }
  const provenance = {
    format: 1, kind: proof ? 'synthetic-state-proof' : 'session-state-library',
    source, sourceIdentity: snapshot.identity, bundleSha256: hash(bytes), bundleBytes: bytes.length,
    dependencyLockSha256: hash(await readFile(resolve(tools, 'pnpm-lock.yaml'))),
    buildManifestSha256: hash(await readFile(resolve(tools, 'package.json'))),
    node: process.versions.node, typecheck, bundler,
    sourceInputs: Object.fromEntries(sourceInputs.map(file => [file, hash(snapshot.read(file))])),
    originalSourceInputs: Object.fromEntries(sourceInputs.map(file => [file, hash(original.read(file))])),
    authoredInputs: Object.fromEntries(await Promise.all(inputs.filter(input => input.startsWith('core/'))
      .map(async file => [file, hash(await readFile(resolve(tools, file)))]))),
    dependencyInputs: Object.fromEntries(await Promise.all(inputs.filter(input => input.startsWith('node_modules/'))
      .map(async file => [file, hash(await readFile(resolve(tools, file)))]))),
    dependencies: notices.dependencies.map(({ name, version, license }) => ({ name, version, license })),
  }
  await writeImmutable(`${output}.licenses.json`, `${JSON.stringify(notices, null, 2)}\n`)
  await writeImmutable(output, bytes)
  await writeImmutable(`${output}.provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`)
  return {
    bundleSha256: provenance.bundleSha256, bundleBytes: bytes.length,
    sourceModules: sourceInputs.length, node: provenance.node, typecheck, bundler,
  }
}

const main = async args => {
  const proof = args.includes('--proof')
  const positional = args.filter(argument => argument !== '--proof')
  if (positional.length !== 4 || positional[0] !== '--source' || positional[2] !== '--output') {
    throw new SessionEngineSourceError('Usage: node build.mjs --source <pinned Git repository> --output <new module.mjs> [--proof]')
  }
  process.stdout.write(`${JSON.stringify(await buildSessionStateModule({ sourceRepository: positional[1], outputPath: positional[3], proof }))}\n`)
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof SessionEngineSourceError ? error.code : error.message}\n`)
    process.exitCode = 1
  })
}
