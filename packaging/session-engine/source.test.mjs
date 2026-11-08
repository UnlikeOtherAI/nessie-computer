import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { prepareSessionEngineSource, T3_SESSION_ENGINE_SOURCE, verifySessionEngineSource } from './source.mjs'
import { readSessionEngineSnapshot } from './snapshot.mjs'
import { createSessionEngineSourceResolver } from './resolver.mjs'
import { applySessionEngineBoundaryPatches, composeSessionEnginePatchManifests } from './patches.mjs'
import { assertSessionEngineSourceGraph } from './graph.mjs'

const artifacts = resolve(dirname(fileURLToPath(import.meta.url)), '../../.artifacts')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const environment = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }

test('prefix-only Node builtins use the runtime admission API, including Node 22 SQLite', () => {
  const resolver = createSessionEngineSourceResolver({ files: [] })
  assert.deepEqual(resolver.resolve('node:sqlite'), { kind: 'builtin', path: 'node:sqlite' })
  assert.deepEqual(resolver.resolve('node:test'), { kind: 'builtin', path: 'node:test' })
  assert.equal(resolver.resolve('node:invented').kind, 'dependency')
  assert.equal(resolver.resolve('sqlite').kind, 'dependency')
})

const fixture = async (context, extra = {}) => {
  await mkdir(artifacts, { recursive: true })
  const root = await mkdtemp(join(artifacts, 'session-engine-source-test-'))
  context.after(async () => {
    assert.equal(dirname(resolve(root)), artifacts)
    await rm(root, { recursive: true, force: true })
  })
  const git = (...args) => execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    encoding: 'buffer', env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  git('init', '--initial-branch=fixture')
  await mkdir(join(root, 'engine'))
  const contents = { LICENSE: 'MIT fixture\n', 'engine/index.ts': 'export const protocol = 2\n', 'pnpm-lock.yaml': 'lockfileVersion: 9\n', ...extra }
  for (const [file, bytes] of Object.entries(contents)) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), bytes)
  }
  await writeFile(join(root, '.gitattributes'), '* -text\n')
  git('add', '.')
  const commit = () => {
    git('-c', 'commit.gpgsign=false', '-c', 'user.name=Executor test', '-c', 'user.email=executor-test@example.invalid',
      'commit', '-m', 'Fixture source')
    return git('rev-parse', 'HEAD').toString('utf8').trim()
  }
  const revision = commit()
  const roots = [...new Set(['LICENSE', 'engine', 'pnpm-lock.yaml', ...Object.keys(extra).map(file => file.split('/')[0])])]
  const archive = git('archive', '--format=tar', revision, '--', ...roots)
  const spec = {
    format: 1, repository: 'fixture', commit: revision, tree: git('rev-parse', `${revision}^{tree}`).toString('utf8').trim(),
    archiveSha256: hash(archive), archiveBytes: archive.length, roots,
    files: Object.fromEntries(Object.entries(contents).map(([file, bytes]) => [file, hash(bytes)])),
  }
  return { root, git, commit, spec, archive, archivePath: join(root, 'output', 'source.tar') }
}

test('the source capsule pins the intended revision, dependency lock and MIT attribution', () => {
  assert.equal(T3_SESSION_ENGINE_SOURCE.commit, '25bf84ab07f53f141c20239c63e383823a9d5ea0')
  assert.equal(T3_SESSION_ENGINE_SOURCE.archiveBytes, 52121600)
  assert.ok(T3_SESSION_ENGINE_SOURCE.files['pnpm-lock.yaml'])
  assert.ok(T3_SESSION_ENGINE_SOURCE.files.LICENSE)
  assert.ok(!T3_SESSION_ENGINE_SOURCE.roots.some(root => /^apps\/(mobile|web|marketing)(?:\/|$)/u.test(root)))
  assert.throws(() => { T3_SESSION_ENGINE_SOURCE.roots.push('apps/mobile') }, TypeError)
})

test('preparation uses committed objects despite dirty, deleted and untracked working files', async context => {
  const input = await fixture(context)
  await writeFile(join(input.root, 'engine/index.ts'), 'changed working source\n')
  await writeFile(join(input.root, 'engine/local-only.txt'), 'untracked fixture\n')
  await rm(join(input.root, 'pnpm-lock.yaml'))
  const result = await prepareSessionEngineSource({
    sourceRepository: input.root, archivePath: input.archivePath,
  }, input.spec)
  assert.deepEqual(await readFile(input.archivePath), input.archive)
  assert.equal(result.commit, input.spec.commit)
  assert.equal(result.sourceFiles, 3)
  assert.equal(result.reused, false)
})

test('an intact output is reusable and an altered output is never overwritten', async context => {
  const input = await fixture(context)
  const options = { sourceRepository: input.root, archivePath: input.archivePath }
  await prepareSessionEngineSource(options, input.spec)
  assert.equal((await prepareSessionEngineSource(options, input.spec)).reused, true)
  await writeFile(input.archivePath, 'different artifact')
  await assert.rejects(prepareSessionEngineSource(options, input.spec), { code: 'SESSION_ENGINE_SOURCE_OUTPUT_CONFLICT' })
  assert.equal(await readFile(input.archivePath, 'utf8'), 'different artifact')
})

test('source tree, individual inputs and archive digests each fail closed', async context => {
  const input = await fixture(context)
  const options = { sourceRepository: input.root, archivePath: input.archivePath }
  await assert.rejects(verifySessionEngineSource(input.root, { ...input.spec, tree: '0'.repeat(40) }),
    { code: 'SESSION_ENGINE_SOURCE_IDENTITY_MISMATCH' })
  await assert.rejects(verifySessionEngineSource(input.root, {
    ...input.spec, files: { ...input.spec.files, LICENSE: '0'.repeat(64) },
  }), { code: 'SESSION_ENGINE_SOURCE_FILE_MISMATCH' })
  await assert.rejects(prepareSessionEngineSource(options, { ...input.spec, archiveSha256: '0'.repeat(64) }),
    { code: 'SESSION_ENGINE_SOURCE_ARCHIVE_MISMATCH' })
  await assert.rejects(readFile(input.archivePath), { code: 'ENOENT' })
})

test('a symlink in the committed input is refused before archiving', async context => {
  const input = await fixture(context)
  const blob = input.git('rev-parse', `${input.spec.commit}:LICENSE`).toString('utf8').trim()
  input.git('update-index', '--add', '--cacheinfo', `120000,${blob},engine/link`)
  const revision = input.commit()
  const spec = { ...input.spec, commit: revision, tree: input.git('rev-parse', `${revision}^{tree}`).toString('utf8').trim() }
  await assert.rejects(verifySessionEngineSource(input.root, spec), { code: 'SESSION_ENGINE_SOURCE_ENTRY_REFUSED' })
})

test('unknown objects and unsafe source roots do not reach preparation', async context => {
  const input = await fixture(context)
  await assert.rejects(verifySessionEngineSource(input.root, { ...input.spec, commit: '0'.repeat(40) }),
    { code: 'SESSION_ENGINE_SOURCE_UNREADABLE' })
  for (const root of ['../other', '/absolute', '.git/config', ':pathspec', '--output=somewhere']) {
    await assert.rejects(verifySessionEngineSource(input.root, { ...input.spec, roots: [root] }),
      { code: 'SESSION_ENGINE_SOURCE_LOCK_INVALID' })
  }
})

test('a verified snapshot is immutable and resolves only the pinned upstream exports', async context => {
  const input = await fixture(context, {
    'packages/fixture/package.json': JSON.stringify({ name: '@t3tools/fixture', exports: {
      '.': { import: './src/index.ts' }, './server/*': { import: './src/server/*.ts' },
    } }),
    'packages/fixture/src/index.ts': 'export const identity = 2\n',
    'packages/fixture/src/server/port.ts': 'export const port = 1\n',
    'engine/relative.ts': 'export const local = 1\n',
  })
  await prepareSessionEngineSource({ sourceRepository: input.root, archivePath: input.archivePath }, input.spec)
  const snapshot = await readSessionEngineSnapshot(input.archivePath, input.spec)
  const bytes = snapshot.read('engine/index.ts')
  bytes.fill(0)
  assert.equal(snapshot.read('engine/index.ts').toString('utf8'), 'export const protocol = 2\n')
  const resolver = createSessionEngineSourceResolver(snapshot)
  assert.equal(resolver.resolve('t3-source:engine/index.ts').path, 'engine/index.ts')
  assert.equal(resolver.resolve('./relative.ts', 'engine/index.ts').path, 'engine/relative.ts')
  assert.equal(resolver.resolve('@t3tools/fixture').path, 'packages/fixture/src/index.ts')
  assert.equal(resolver.resolve('@t3tools/fixture/server/port').path, 'packages/fixture/src/server/port.ts')
  assert.equal(resolver.resolve('node:sqlite').kind, 'builtin')
  assert.equal(resolver.resolve('effect/Effect').kind, 'dependency')
  assert.throws(() => resolver.resolve('@t3tools/fixture/hidden'), { code: 'SESSION_ENGINE_SOURCE_EXPORT_REFUSED' })
  assert.throws(() => resolver.resolve('../../outside', 'engine/index.ts'), { code: 'SESSION_ENGINE_SOURCE_FILE_ABSENT' })
})

test('a capsule with wrong bytes or a malformed tar header never reaches source resolution', async context => {
  const input = await fixture(context)
  await mkdir(dirname(input.archivePath), { recursive: true })
  const altered = Buffer.from(input.archive)
  altered[0] ^= 1
  await writeFile(input.archivePath, altered)
  await assert.rejects(readSessionEngineSnapshot(input.archivePath, input.spec), { code: 'SESSION_ENGINE_SOURCE_CAPSULE_INVALID' })
  await assert.rejects(readSessionEngineSnapshot(input.archivePath, { ...input.spec, archiveSha256: hash(altered) }),
    { code: 'SESSION_ENGINE_SOURCE_CAPSULE_INVALID' })
})

test('ordered boundary patches bind original bytes and results without changing the capsule', async context => {
  const input = await fixture(context)
  await prepareSessionEngineSource({ sourceRepository: input.root, archivePath: input.archivePath }, input.spec)
  const snapshot = await readSessionEngineSnapshot(input.archivePath, input.spec)
  const original = snapshot.read('engine/index.ts')
  const after = Buffer.from('export const protocol = 3\n')
  const manifest = { format: 1, sourceCommit: input.spec.commit, patches: [{
    id: 'fixture-only', file: 'engine/index.ts', from: 'protocol = 2', to: 'protocol = 3',
    beforeSha256: hash(original), afterSha256: hash(after),
  }] }
  const encoded = Buffer.from(JSON.stringify(manifest))
  const modified = applySessionEngineBoundaryPatches(snapshot, encoded)
  assert.deepEqual(modified.read('engine/index.ts'), after)
  assert.deepEqual(snapshot.read('engine/index.ts'), original)
  assert.equal(modified.identity.archiveSha256, snapshot.identity.archiveSha256)
  assert.equal(modified.identity.orderedPatchesSha256, hash(encoded))
  assert.throws(() => applySessionEngineBoundaryPatches(modified, encoded),
    { code: 'SESSION_ENGINE_BOUNDARY_PATCH_SOURCE_MISMATCH' })
  manifest.patches[0].afterSha256 = '0'.repeat(64)
  assert.throws(() => applySessionEngineBoundaryPatches(snapshot, Buffer.from(JSON.stringify(manifest))),
    { code: 'SESSION_ENGINE_BOUNDARY_PATCH_RESULT_MISMATCH' })
})

test('one composition binds ordered families and refuses a previously patched input', async context => {
  const input = await fixture(context)
  await prepareSessionEngineSource({ sourceRepository: input.root, archivePath: input.archivePath }, input.spec)
  const snapshot = await readSessionEngineSnapshot(input.archivePath, input.spec)
  const family = (id, before, after) => ({ id, bytes: Buffer.from(JSON.stringify({ format: 1,
    sourceCommit: input.spec.commit, patches: [{ id, file: 'engine/index.ts',
      from: before, to: after, beforeSha256: hash(`export const ${before}\n`),
      afterSha256: hash(`export const ${after}\n`) }] })) })
  const families = [family('state', 'protocol = 2', 'protocol = 3'),
    family('client', 'protocol = 3', 'protocol = 4')]
  const manifest = composeSessionEnginePatchManifests(snapshot, families)
  assert.deepEqual(manifest, composeSessionEnginePatchManifests(snapshot, families))
  const applied = applySessionEngineBoundaryPatches(snapshot, manifest)
  assert.equal(applied.read('engine/index.ts').toString(), 'export const protocol = 4\n')
  assert.equal(applied.identity.orderedPatchesSha256, hash(manifest))
  assert.notEqual(hash(manifest), hash(composeSessionEnginePatchManifests(snapshot, [...families].reverse())))
  assert.throws(() => composeSessionEnginePatchManifests(applied, families),
    { code: 'SESSION_ENGINE_BOUNDARY_PATCH_COMPOSITION_REFUSED' })
  assert.throws(() => composeSessionEnginePatchManifests(snapshot, [families[0], families[0]]),
    { code: 'SESSION_ENGINE_BOUNDARY_PATCH_MANIFEST_REFUSED' })
})

test('derived source binds exact original ranges and never replaces an existing file', async context => {
  const input = await fixture(context)
  await prepareSessionEngineSource({ sourceRepository: input.root, archivePath: input.archivePath }, input.spec)
  const snapshot = await readSessionEngineSnapshot(input.archivePath, input.spec)
  const original = snapshot.read('engine/index.ts')
  const file = 'apps/server/src/fixture-port.ts'
  const derived = Buffer.concat([Buffer.from('// derived fixture\n'), original])
  const patch = { id: 'fixture-derivation', file, beforeSha256: null, afterSha256: hash(derived),
    create: [{ text: '// derived fixture\n' }, { sourceFile: 'engine/index.ts', start: 0,
      end: original.length, sha256: hash(original) }] }
  const manifest = () => Buffer.from(JSON.stringify({ format: 1, sourceCommit: input.spec.commit, patches: [patch] }))
  const applied = applySessionEngineBoundaryPatches(snapshot, manifest())
  assert.deepEqual(applied.read(file), derived)
  assert.ok(applied.files.includes(file))
  const bytes = applied.read(file)
  bytes.fill(0)
  assert.deepEqual(applied.read(file), derived)
  patch.create[1].sha256 = '0'.repeat(64)
  assert.throws(() => applySessionEngineBoundaryPatches(snapshot, manifest()),
    { code: 'SESSION_ENGINE_BOUNDARY_PATCH_SOURCE_MISMATCH' })
  patch.file = 'engine/index.ts'
  assert.throws(() => applySessionEngineBoundaryPatches(snapshot, manifest()),
    { code: 'SESSION_ENGINE_BOUNDARY_PATCH_CREATE_REFUSED' })
})

test('the engine graph rejects product, provider, vault and exporter implementations', () => {
  for (const file of ['server.ts', 'ws.ts', 'auth/ServerSecretStore.ts', 'preview/Manager.ts',
    'telemetry/ProviderUsageAnalytics.ts', 'provider/Drivers/CodexDriver.ts', 'provider/ProviderCredentialStore.ts',
    'provider/ProviderRegistry.ts', 'provider/builtInProviderCatalog.ts', 'orchestration-v2/runtimeLayer.ts',
    'serverSettings.ts', 'config.ts', 'cloud/config.ts', 'provider/ProviderUsageService.ts',
    'orchestration-v2/ThreadManagementService.ts']) {
    assert.throws(() => assertSessionEngineSourceGraph([`apps/server/src/${file}`]),
      { code: 'SESSION_ENGINE_AGGREGATE_REFUSED' })
  }
  assert.doesNotThrow(() => assertSessionEngineSourceGraph([
    'apps/server/src/orchestration-v2/Orchestrator.ts', 'apps/server/src/config.session-port.ts',
    'apps/server/src/provider/ProviderInstanceRegistry.session-port.ts',
    'apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts',
    'packages/contracts/src/provider.ts',
  ]))
})

test('a derivation after a source refactor binds that exact source version', async context => {
  const input = await fixture(context)
  await prepareSessionEngineSource({ sourceRepository: input.root, archivePath: input.archivePath }, input.spec)
  const snapshot = await readSessionEngineSnapshot(input.archivePath, input.spec)
  const before = snapshot.read('engine/index.ts')
  const after = Buffer.from('export const protocol = 3\n')
  const create = { id: 'derive-current', file: 'apps/server/src/current.ts', beforeSha256: null,
    afterSha256: hash(after), create: [{ sourceFile: 'engine/index.ts', sourceStage: 'current',
      sourceSha256: hash(after), start: 0, end: after.length, sha256: hash(after) }] }
  const manifest = () => Buffer.from(JSON.stringify({ format: 1, sourceCommit: input.spec.commit, patches: [{
    id: 'change-source', file: 'engine/index.ts', from: 'protocol = 2', to: 'protocol = 3',
    beforeSha256: hash(before), afterSha256: hash(after),
  }, create] }))
  assert.deepEqual(applySessionEngineBoundaryPatches(snapshot, manifest()).read(create.file), after)
  create.create[0].sourceSha256 = hash(before)
  assert.throws(() => applySessionEngineBoundaryPatches(snapshot, manifest()),
    { code: 'SESSION_ENGINE_BOUNDARY_PATCH_SOURCE_MISMATCH' })
})
