// The packaged executor runtime: the layout both supervisors verify before
// they run anything. `desktop/src-tauri/src/executor_companion/runtime.rs` and
// `executor/src/runtime-integrity.ts` read exactly this file set and this
// manifest shape, so this module is their single producer — the desktop bundle
// and the Linux `nessie-executor` package are two callers of one preparation,
// never two implementations of it.
//
// The layout is host-shaped in two ways only, and the manifest states both so
// no reader has to guess from its own platform: Windows runs
// `nessie-executor-runtime.exe` and installs `LICENSE` beside it, while POSIX
// runs `nessie-executor-runtime` and keeps the licence one directory up.
//
// The Node binary ships under the product's name, never as `node`: people
// clearing a loaded machine stop every process called `node` (`taskkill /IM
// node.exe`, `Stop-Process -Name node`, `pkill node`), and a daemon that shares
// that name dies with the dev servers. Its children start from
// `process.execPath`, so they carry the same name.
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { inspectPackagedNodeRuntime } from './packaged-node.mjs'

/** The files present in every package, whatever the host. */
export const EXECUTOR_RUNTIME_FIXED_FILES = ['nessie-executor.cjs', 'manifest.json', 'NODE_LICENSE']

/** The only two names the packaged Node binary may have. */
export const EXECUTOR_NODE_EXECUTABLES = ['nessie-executor-runtime', 'nessie-executor-runtime.exe']

/** The only two names the packaged native helper may have. */
export const EXECUTOR_NATIVE_HELPERS = ['nessie-executor-native', 'nessie-executor-native.exe']

/**
 * The only manifest format both supervisors accept. `nodeExecutable` was added
 * without a format bump on purpose: a reader that ignores an unknown key still
 * verifies everything format 1 ever promised, and both readers resolve the Node
 * file name from the manifest rather than from their own platform.
 */
export const EXECUTOR_RUNTIME_MANIFEST_FORMAT = 1

const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

/** Windows installs Node's `LICENSE` beside `node.exe`; POSIX keeps it one level up. */
export const nodeLicensePath = (nodeExecutablePath, platform) => (
  platform === 'win32'
    ? resolve(dirname(nodeExecutablePath), 'LICENSE')
    : resolve(dirname(nodeExecutablePath), '..', 'LICENSE')
)

export const nodeExecutableName = (platform) => (
  platform === 'win32' ? 'nessie-executor-runtime.exe' : 'nessie-executor-runtime'
)

const nativeHelperName = (platform) => (
  platform === 'win32' ? 'nessie-executor-native.exe' : 'nessie-executor-native'
)

const readNodeLicense = async (path, nodeExecutablePath) => {
  try {
    return await readFile(path)
  } catch {
    throw new Error(`Unable to locate the Node.js license beside ${nodeExecutablePath}.`)
  }
}

/**
 * Windows' MSI and desktop builders may run under a Node installer that omits
 * LICENSE. Only those Windows installer-facing callers may obtain the official
 * licence for their exact Node version; all ordinary preparations remain local
 * and fail closed when their package provenance is incomplete.
 */
export const resolveWindowsPackagedNodeLicense = async (nodeExecutablePath = process.execPath) => {
  const localPath = nodeLicensePath(nodeExecutablePath, 'win32')
  try {
    return await readNodeLicense(localPath, nodeExecutablePath)
  } catch {
    const { nodeVersion } = inspectPackagedNodeRuntime(nodeExecutablePath)
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`)
    if (!response.ok) {
      throw new Error(`Unable to download the Node.js license for ${nodeVersion}.`)
    }
    const license = await response.text()
    if (!license.startsWith('Node.js is licensed for use as follows:')) {
      throw new Error(`Downloaded Node.js license for ${nodeVersion} was invalid.`)
    }
    return Buffer.from(license)
  }
}

/**
 * Bundles the executor CLI, copies the build host's Node beside it with its
 * licence, optionally copies the native helper, and writes the sha256 manifest.
 * The copied Node is the runtime the package ships, so every build host must run
 * Node 24 with the SQLite authorization and transaction-state APIs.
 *
 * `platform` and `nodeExecutablePath` are injectable so both layouts are
 * exercised from one host; every caller in the repository takes the defaults.
 * `nodeLicenseContents` lets an installer-facing caller supply the official
 * licence when its Node distribution omits that otherwise required file.
 */
export const prepareExecutorRuntime = async ({
  entryPoint,
  executorVersion = 'development',
  executorSourceCommit,
  executorAppleTeamId = '',
  nativeHelperPath,
  nodeLicenseContents,
  nodeExecutablePath = process.execPath,
  outputDirectory,
  platform = process.platform,
}) => {
  const runtimeDirectory = resolve(outputDirectory)
  const sourceCommit = executorSourceCommit ?? execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('The executor source revision must be a complete Git SHA.')
  const executorBundlePath = resolve(runtimeDirectory, 'nessie-executor.cjs')
  const nodeExecutable = nodeExecutableName(platform)
  const nodePath = resolve(runtimeDirectory, nodeExecutable)
  const licenseSourcePath = nodeLicensePath(nodeExecutablePath, platform)
  const isPosix = platform !== 'win32'

  const license = nodeLicenseContents ?? await readNodeLicense(licenseSourcePath, nodeExecutablePath)
  // Reject unsupported inputs before replacing an existing staging directory.
  const selectedNode = inspectPackagedNodeRuntime(nodeExecutablePath)
  await rm(runtimeDirectory, { force: true, recursive: true })
  await mkdir(runtimeDirectory, { recursive: true })

  await build({
    bundle: true,
    define: {
      __NESSIE_EXECUTOR_VERSION__: JSON.stringify(executorVersion),
      __NESSIE_EXECUTOR_SOURCE_COMMIT__: JSON.stringify(sourceCommit),
      __NESSIE_EXECUTOR_APPLE_TEAM_ID__: JSON.stringify(executorAppleTeamId),
    },
    entryPoints: [resolve(entryPoint)],
    format: 'cjs',
    outfile: executorBundlePath,
    platform: 'node',
    target: 'node24',
  })
  // esbuild follows the builder's umask; group-writable output cannot be a
  // trusted Linux package even after dpkg gives it root ownership.
  if (isPosix) await chmod(executorBundlePath, 0o644)
  await copyFile(nodeExecutablePath, nodePath)
  if (isPosix) await chmod(nodePath, 0o755)
  const copiedNode = inspectPackagedNodeRuntime(nodePath)
  if (copiedNode.nodeVersion !== selectedNode.nodeVersion) throw new Error('The selected Node runtime changed during preparation.')
  await writeFile(resolve(runtimeDirectory, 'NODE_LICENSE'), license, { mode: 0o644 })

  // The helper establishes and proves the Windows state DACL, so a package that
  // ships one pins its bytes in the same manifest as the runtime: an unverified
  // helper would decide privacy for state it could also be swapped to expose.
  let nativeHelper
  if (nativeHelperPath !== undefined) {
    nativeHelper = nativeHelperName(platform)
    const helperTargetPath = resolve(runtimeDirectory, nativeHelper)
    await copyFile(resolve(nativeHelperPath), helperTargetPath)
    if (isPosix) await chmod(helperTargetPath, 0o755)
  }

  const manifest = {
    executorVersion,
    executorSourceCommit: sourceCommit,
    ...(platform === 'win32' ? { managedRuntimeGuardVersion: 2 } : {}),
    executorBundleSha256: await digest(executorBundlePath),
    format: EXECUTOR_RUNTIME_MANIFEST_FORMAT,
    ...(nativeHelper === undefined
      ? {}
      : {
        nativeHelper,
        nativeHelperSha256: await digest(resolve(runtimeDirectory, nativeHelper)),
      }),
    nodeExecutable,
    nodeSha256: await digest(nodePath),
    nodeVersion: copiedNode.nodeVersion,
  }
  const manifestPath = resolve(runtimeDirectory, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })

  return { executorBundlePath, manifest, manifestPath, nodePath, runtimeDirectory }
}
