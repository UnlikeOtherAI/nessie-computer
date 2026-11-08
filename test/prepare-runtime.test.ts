import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { nodeExecutableName, nodeLicensePath, prepareExecutorRuntime } from '../scripts/prepare-runtime.mjs'
import { inspectPackagedNodeRuntime } from '../scripts/packaged-node.mjs'
import { collectExecutorRuntimeFacts, verifyExecutorRuntime } from '../src/runtime-integrity.js'

const ENTRY_POINT = fileURLToPath(new URL('../src/index.ts', import.meta.url))

test('the selected Node executes SQLite authorization and reports its own version', () => {
  assert.deepEqual(inspectPackagedNodeRuntime(process.execPath), { nodeVersion: process.versions.node })
})

test('missing SQLite authorization refuses preparation before replacing staged bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-node-capabilities-'))
  try {
    const preload = join(directory, 'no-authorizer.cjs')
    await writeFile(preload, "require('node:sqlite').DatabaseSync.prototype.setAuthorizer = undefined\n")
    const outputDirectory = join(directory, 'runtime')
    await mkdir(outputDirectory)
    await writeFile(join(outputDirectory, 'previous'), 'preserved')
    const producer = new URL('../scripts/prepare-runtime.mjs', import.meta.url).href
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {prepareExecutorRuntime} from ${JSON.stringify(producer)};`
      + `await prepareExecutorRuntime(${JSON.stringify({ entryPoint: ENTRY_POINT, outputDirectory,
        nodeLicenseContents: 'fixture license' })});`], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"` },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /requires Node 24 with SQLite setAuthorizer/u)
    assert.equal(await readFile(join(outputDirectory, 'previous'), 'utf8'), 'preserved')
  } finally { await rm(directory, { force: true, recursive: true }) }
})

const digest = async (path: string): Promise<string> => (
  createHash('sha256').update(await readFile(path)).digest('hex')
)

test('the shared preparation writes the exact runtime layout both supervisors verify', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-prepare-'))
  try {
    const prepared = await prepareExecutorRuntime({
      entryPoint: ENTRY_POINT,
      nodeLicenseContents: Buffer.from('node license'),
      outputDirectory: join(directory, 'executor-runtime'),
    })

    const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8')) as Record<string, unknown>
    assert.equal(manifest.format, 1)
    assert.equal(manifest.nodeVersion, process.versions.node)
    assert.equal(manifest.nodeExecutable, nodeExecutableName(process.platform))
    assert.equal(manifest.nodeSha256, await digest(prepared.nodePath))
    assert.equal(manifest.executorBundleSha256, await digest(prepared.executorBundlePath))
    assert.equal(manifest.nativeHelper, undefined)
    if (process.platform !== 'win32') {
      assert.equal((await lstat(prepared.nodePath)).mode & 0o111, 0o111)
    }
    assert.ok((await readFile(join(prepared.runtimeDirectory, 'NODE_LICENSE'), 'utf8')).length > 0)
    const bundledExecutor = await readFile(prepared.executorBundlePath, 'utf8')
    assert.match(bundledExecutor, /nessie-executor/)
    assert.match(bundledExecutor, /deeptest-source/)
    assert.match(bundledExecutor, /deeptest-inference/)
    // One file still: the commands the entry loads on demand, built in and the CLI's, both run from it.
    const packaged = (args: string[]) => spawnSync(process.execPath, [prepared.executorBundlePath, ...args], {
      encoding: 'utf8', env: { ...process.env, NESSIE_EXECUTOR_PACKAGED_CLI: '1' }, timeout: 60_000,
    })
    const version = packaged(['--version'])
    assert.equal(version.status, 0, version.stderr)
    assert.equal(version.stdout, 'nessie-executor development\n')
    const host = packaged(['coding-session-host'])
    assert.equal(host.status, 1)
    assert.match(host.stderr, /Usage: nessie-executor coding-session-host/u)
    const inference = packaged(['deeptest-inference'])
    assert.equal(inference.status, 1)
    assert.match(inference.stderr, /--inference-grant-file/u)

    // The producer and the verifier agree by construction, not by two
    // constants happening to match: ownership is a packaged-install rule, so
    // the staging copy is verified under the non-Linux arm.
    const facts = await collectExecutorRuntimeFacts(prepared.runtimeDirectory)
    assert.deepEqual(verifyExecutorRuntime({ ...facts, platform: 'darwin' }), { ok: true })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

/**
 * Both layouts are produced from one host by injecting the platform and a Node
 * path laid out the way that platform lays it out â€” the test never branches on
 * `process.platform`, so the Windows layout is exercised on Linux CI and the
 * POSIX layout on a Windows build machine.
 */
test('the Windows layout ships nessie-executor-runtime.exe and the licence installed beside it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-prepare-windows-'))
  try {
    // A Windows Node install: `node.exe` and `LICENSE` in the same directory.
    const nodeHome = join(directory, 'nodejs')
    await mkdir(nodeHome, { recursive: true })
    const nodeExecutablePath = join(nodeHome, 'node.exe')
    await copyFile(process.execPath, nodeExecutablePath)
    await writeFile(join(nodeHome, 'LICENSE'), 'node license')
    const helperSourcePath = join(directory, 'nessie-executor-native.exe')
    await writeFile(helperSourcePath, 'windows-native-helper')

    assert.equal(nodeLicensePath(nodeExecutablePath, 'win32'), join(nodeHome, 'LICENSE'))

    const prepared = await prepareExecutorRuntime({
      entryPoint: ENTRY_POINT,
      nativeHelperPath: helperSourcePath,
      nodeExecutablePath,
      outputDirectory: join(directory, 'executor-runtime'),
      platform: 'win32',
    })

    assert.equal(prepared.nodePath, join(prepared.runtimeDirectory, 'nessie-executor-runtime.exe'))
    const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8')) as Record<string, unknown>
    assert.equal(manifest.format, 1)
    assert.equal(manifest.nodeExecutable, 'nessie-executor-runtime.exe')
    assert.equal(manifest.managedRuntimeGuardVersion, 2)
    assert.equal(manifest.nodeSha256, await digest(prepared.nodePath))
    assert.equal(manifest.nativeHelper, 'nessie-executor-native.exe')
    assert.equal(
      manifest.nativeHelperSha256,
      await digest(join(prepared.runtimeDirectory, 'nessie-executor-native.exe')),
    )
    assert.equal(await readFile(join(prepared.runtimeDirectory, 'NODE_LICENSE'), 'utf8'), 'node license')

    const facts = await collectExecutorRuntimeFacts(prepared.runtimeDirectory)
    assert.deepEqual(verifyExecutorRuntime({ ...facts, platform: 'win32' }), { ok: true })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('the POSIX layout reads the licence one directory above the Node binary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-prepare-posix-'))
  try {
    // A POSIX Node install: `bin/node` with `LICENSE` at the prefix root.
    const nodeExecutablePath = join(directory, 'nodejs', 'bin', 'node')
    await mkdir(dirname(nodeExecutablePath), { recursive: true })
    await copyFile(process.execPath, nodeExecutablePath)
    await writeFile(join(directory, 'nodejs', 'LICENSE'), 'node license')

    assert.equal(nodeLicensePath(nodeExecutablePath, 'linux'), join(directory, 'nodejs', 'LICENSE'))

    const prepared = await prepareExecutorRuntime({
      entryPoint: ENTRY_POINT,
      nodeExecutablePath,
      outputDirectory: join(directory, 'executor-runtime'),
      platform: 'linux',
    })

    assert.equal(prepared.nodePath, join(prepared.runtimeDirectory, 'nessie-executor-runtime'))
    const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8')) as Record<string, unknown>
    assert.equal(manifest.nodeExecutable, 'nessie-executor-runtime')
    if (process.platform !== 'win32') {
      assert.equal((await lstat(prepared.nodePath)).mode & 0o111, 0o111)
    }
    assert.equal(await readFile(join(prepared.runtimeDirectory, 'NODE_LICENSE'), 'utf8'), 'node license')
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('a Node install with no licence beside it stops the build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-prepare-licence-'))
  try {
    const nodeExecutablePath = join(directory, 'nodejs', 'node.exe')
    await mkdir(dirname(nodeExecutablePath), { recursive: true })
    await copyFile(process.execPath, nodeExecutablePath)

    await assert.rejects(
      prepareExecutorRuntime({
        entryPoint: ENTRY_POINT,
        nodeExecutablePath,
        outputDirectory: join(directory, 'executor-runtime'),
        platform: 'win32',
      }),
      /Unable to locate the Node\.js license/,
    )
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('an installer-facing caller can provide the official licence when Node omits it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-prepare-provided-licence-'))
  try {
    const nodeExecutablePath = join(directory, 'nodejs', 'node.exe')
    await mkdir(dirname(nodeExecutablePath), { recursive: true })
    await copyFile(process.execPath, nodeExecutablePath)

    const prepared = await prepareExecutorRuntime({
      entryPoint: ENTRY_POINT,
      nodeExecutablePath,
      nodeLicenseContents: Buffer.from('official node license'),
      outputDirectory: join(directory, 'executor-runtime'),
      platform: 'win32',
    })

    assert.equal(
      await readFile(join(prepared.runtimeDirectory, 'NODE_LICENSE'), 'utf8'),
      'official node license',
    )
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
