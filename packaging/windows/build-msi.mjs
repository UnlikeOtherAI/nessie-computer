// Builds NessieExecutor_<version>_x64.msi: the standalone `service` supervisor
// for Windows computers with no desktop app.
//
// It stages exactly what the installer ships — the packaged runtime from the one
// shared preparation, plus the two Rust binaries this package adds — and then
// hands that directory to the WiX toolset. When the trusted release pipeline
// supplies its signing command, every executable child is signed before its
// bytes enter a runtime or resource manifest; the workflow signs the finished
// MSI separately. A development build receives no signing command.
//
// This runs on Windows only, and says so immediately rather than failing three
// steps later on a missing `.exe`.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { prepareExecutorRuntime, resolveWindowsPackagedNodeLicense } from '../../scripts/prepare-runtime.mjs'
import { signWindowsArtifacts } from '../../scripts/windows-sign.mjs'
import { BUILT_BINARIES, msiFileName, msiVersion } from './msi-plan.mjs'
import { sealWindowsLaunchConsumers } from './launch-consumers.mjs'

const run = promisify(execFile)
const require = createRequire(import.meta.url)

const packagingDirectory = dirname(fileURLToPath(import.meta.url))
const executorDirectory = resolve(packagingDirectory, '../..')
const repositoryDirectory = executorDirectory
const outputDirectory = resolve(repositoryDirectory, 'dist')
const stagingDirectory = join(outputDirectory, 'nessie-executor-windows')
/** The installer's own artwork and licence, which are not staged payload. */
const assetsDirectory = join(packagingDirectory, 'assets')

/**
 * The WiX major this authoring targets. WiX is a .NET global tool, so the
 * version is pinned rather than "whatever is installed": its schema and its CLI
 * both change between majors. WiX 7 requires an explicit OSMF EULA acceptance;
 * adopting that is an owner decision and must never be hidden inside this build.
 */
const WIX_VERSION = '5.0.2'

/**
 * The WiX dialog set this package's UI comes from, pinned to the same major as
 * the toolset: its dialogs and its variable names both change between majors.
 * It is a separate install from the toolset itself, so the message below names
 * the exact command rather than leaving a person to discover it from a build
 * error about an unknown `ui:WixUI` element.
 */
const UI_EXTENSION = `WixToolset.UI.wixext/${WIX_VERSION}`

const requireWindows = () => {
  if (process.platform !== 'win32') {
    throw new Error(
      'The Nessie Executor MSI is built on Windows. It needs the MSVC toolchain for its two Rust '
      + 'binaries, a Windows Node 24 to copy as the packaged runtime, and the WiX toolset '
      + `(dotnet tool install --global wix --version ${WIX_VERSION}) `
      + `with its UI extension (wix extension add --global ${UI_EXTENSION}). `
      + `This host is ${process.platform}.`,
    )
  }
  if (process.versions.node.split('.')[0] !== '24') {
    throw new Error('Build the Windows release with Node 24 so its packaged runtime matches the supported version.')
  }
}

const packageVersion = async () => msiVersion(
  process.env.NESSIE_EXECUTOR_VERSION
  ?? JSON.parse(await readFile(join(executorDirectory, 'package.json'), 'utf8')).version,
)

const cargoRelease = async (manifestDirectory) => {
  await run('cargo', ['build', '--release'], { cwd: manifestDirectory })
}

/**
 * The tray is a Tauri application, so its executable is produced by the Tauri
 * CLI rather than by cargo directly: `--no-bundle` builds and signs nothing,
 * leaving the binary for the MSI to carry.
 */
const buildTray = async () => {
  // Resolve the installed CLI from this module. A checkout nested as Nessie's
  // submodule has its own pnpm workspace boundary, while the hoisted dependency
  // and binary belong to the enclosing installation.
  await run(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), 'build', '--no-bundle'], {
    cwd: join(executorDirectory, 'tray-windows'),
  })
}

/**
 * The sandbox payload: the Hyper-V bridge, the four pinned PowerShell scripts,
 * the guest kernel, the portable initrd builder and the Linux guest init it
 * assembles. `guest/init` is a *Linux* binary — it is never run on this
 * machine, only placed inside the initrd — while `build-initrd.exe` runs on the
 * host, which is why the two are cross-compiled for different targets.
 *
 * The kernel is not built here: it needs a Linux toolchain
 * (`executor/guest/kernel/build.sh`). The release workflow supplies its
 * bootable artifact through NESSIE_GUEST_KERNEL; Windows PR CI supplies its
 * verified non-bootable fixture to exercise this MSI path without a job edge.
 */
const stageResources = async (destination) => {
  await mkdir(join(destination, 'guest'), { recursive: true })
  await mkdir(join(destination, 'scripts'), { recursive: true })

  await cargoRelease(join(executorDirectory, 'hyperv-bridge'))
  const bridgePath = join(executorDirectory, 'hyperv-bridge/target/release/nessie-hyperv-bridge.exe')
  await signWindowsArtifacts([bridgePath])
  await copyFile(bridgePath, join(destination, 'nessie-hyperv-bridge.exe'))

  const guestDirectory = join(executorDirectory, 'guest')
  const initrdBuilderPath = join(destination, 'guest/build-initrd.exe')
  await run('go', ['build', '-trimpath', '-o', initrdBuilderPath, './cmd/build-initrd'], {
    cwd: guestDirectory,
    env: { ...process.env, CGO_ENABLED: '0', GOARCH: 'amd64', GOOS: 'windows' },
  })
  await signWindowsArtifacts([initrdBuilderPath])
  await run('go', ['build', '-trimpath', '-o', join(destination, 'guest/init'), '.'], {
    cwd: guestDirectory,
    env: { ...process.env, CGO_ENABLED: '0', GOARCH: 'amd64', GOOS: 'linux' },
  })

  const kernelPath = process.env.NESSIE_GUEST_KERNEL
  if (!kernelPath) {
    throw new Error(
      'Set NESSIE_GUEST_KERNEL to the bzImage built by executor/guest/kernel/build.sh. '
      + 'Without a guest kernel the package could install a sandbox that cannot boot.',
    )
  }
  await copyFile(kernelPath, join(destination, 'guest/bzImage'))

  for (const name of ['create.ps1', 'remove.ps1', 'start.ps1', 'stop.ps1']) {
    await copyFile(join(packagingDirectory, 'scripts', name), join(destination, 'scripts', name))
  }

}

/**
 * One SHA-256 per shipped sandbox resource, so an integrity check can say which
 * file changed rather than only that something did. It is what the daemon
 * checks a PowerShell script against before running it. `manifest.json` is
 * excluded from its own listing, and paths are recorded with forward slashes so
 * one reader serves both packages.
 */
const resourceManifest = async (directory) => {
  const files = []
  const walk = async (current) => {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name !== 'manifest.json') {
        files.push({ path: relative(directory, path).split('\\').join('/'), sha256: await sha256File(path) })
      }
    }
  }
  await walk(directory)
  return { files, version: 1 }
}

const stage = async (version) => {
  await rm(stagingDirectory, { force: true, recursive: true })
  await mkdir(stagingDirectory, { recursive: true })

  await cargoRelease(join(executorDirectory, 'native'))
  await cargoRelease(join(executorDirectory, 'service-windows'))
  await buildTray()

  const nativeHelperPath = join(
    executorDirectory,
    'native/target/release/nessie-executor-native.exe',
  )
  const sources = {
    'nessie-executor-service.exe': join(
      executorDirectory,
      'service-windows/target/release/nessie-executor-service.exe',
    ),
    'nessie-executor-tray.exe': join(
      executorDirectory,
      'tray-windows/src-tauri/target/release/nessie-executor-tray.exe',
    ),
  }
  await signWindowsArtifacts([nativeHelperPath, ...BUILT_BINARIES.map((name) => sources[name])])

  // One producer for the runtime layout and its manifest, shared with the
  // desktop bundle and the Linux package. The native helper is pinned in that
  // manifest because the service secures its state root through it — and it is
  // hashed after signing, so the shipped bytes are the ones the manifest names.
  await prepareExecutorRuntime({
    entryPoint: join(executorDirectory, 'src/index.ts'),
    executorVersion: version,
    nativeHelperPath,
    nodeLicenseContents: await resolveWindowsPackagedNodeLicense(),
    outputDirectory: stagingDirectory,
    platform: 'win32',
  })

  for (const name of BUILT_BINARIES) {
    await copyFile(sources[name], join(stagingDirectory, name))
  }
  // Signatures alone cannot distinguish an older signed direct-Node launcher.
  // Bind the service/tray's final signed bytes into this exact release digest.
  await sealWindowsLaunchConsumers(stagingDirectory)
  await copyFile(join(packagingDirectory, 'nessie-executor.cmd'), join(stagingDirectory, 'nessie-executor.cmd'))
  await copyFile(join(stagingDirectory, 'nessie-executor-native.exe'), join(stagingDirectory, 'nessie-computer-updater.exe'))

  const resourcesDirectory = join(stagingDirectory, 'resources')
  await stageResources(resourcesDirectory)
  await writeFile(
    join(resourcesDirectory, 'manifest.json'),
    `${JSON.stringify(await resourceManifest(resourcesDirectory), null, 2)}\n`,
  )
}

const sha256File = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

requireWindows()
const version = await packageVersion()
const name = msiFileName(version)
const packagePath = join(outputDirectory, name)

await mkdir(outputDirectory, { recursive: true })
await stage(version)
await run('wix', [
  'build',
  join(packagingDirectory, 'nessie-executor.wxs'),
  '-arch', 'x64',
  // The dialog set, its two bitmaps, the licence and the Apps & features icon.
  // Without the extension the package still builds, but installs through
  // Windows Installer's bare progress bar and a system dialog with an OK
  // button, which is not a product.
  '-ext', UI_EXTENSION,
  '-bindpath', `Assets=${assetsDirectory}`,
  '-d', `Version=${version}`,
  '-d', `StagingDir=${stagingDirectory}`,
  '-d', `EnableUpdater=${process.env.NESSIE_WINDOWS_SIGN_COMMAND ? '1' : '0'}`,
  '-o', packagePath,
])
// Wix.exe builds and validates as separate operations. The tray's autostart
// entry is a per-user registry value in a per-machine package by design: the
// service serves everyone, while the tray is one person's control surface.
// Suppress only the two ICEs that describe that deliberate shape.
await run('wix', [
  'msi', 'validate',
  '-sice', 'ICE38',
  '-sice', 'ICE64',
  packagePath,
])
await rm(stagingDirectory, { force: true, recursive: true })
await writeFile(`${packagePath}.sha256`, `${await sha256File(packagePath)}  ${name}\n`, {
  mode: 0o644,
})

process.stdout.write(`${packagePath}\n${packagePath}.sha256\n`)
