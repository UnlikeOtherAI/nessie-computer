// Builds NessieExecutor_<version>_<arch>.dmg: the downloadable installer for the
// macOS menu bar app, which is how a person with no terminal reaches an
// executor's settings, what it may reach, and the tools it may run.
//
// The DMG is the macOS trust root, and unlike the Linux package it is one Apple
// itself vouches for: a `Developer ID Application` signature over a hardened
// runtime, a notarization ticket stapled to both the app and the image, and a
// Gatekeeper assessment that actually passes. That last check is the point — a
// successful `notarytool submit` says a ticket was issued, not that this
// artifact carries it.
//
// There is no third outcome. A host without those credentials may build only the
// development image, whose file name, volume name and closing banner all say it
// may not be installed. Nothing here ad-hoc signs and calls the result
// distributable: docs/standards/build-and-release.md → "macOS release-signing
// policy" is the rule, and this file is where it binds for this artifact.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { prepareMacExecutorRuntime } from './prepare-runtime.mjs'
import { finishMacManagedManifest } from './managed-release.mjs'
import { signMacApp, notarizeAndStaple } from './sign-app.mjs'
import {
  APPLICATIONS_SYMLINK_NAME,
  APPLICATIONS_SYMLINK_TARGET,
  BUILD_APP_SCRIPT,
  DEVELOPMENT_MARKER,
  EXECUTOR_RUNTIME_DIRECTORY,
  assertBundleIdentifier,
  codesignArguments,
  dmgFileName,
  dmgVolumeName,
  gatekeeperAssessArguments,
  hdiutilArguments,
  missingBuildScriptMessage,
  resolveBuildMode,
  resolveDmgVersion,
} from './dmg-plan.mjs'

const run = promisify(execFile)

const packagingDirectory = dirname(fileURLToPath(import.meta.url))
const executorDirectory = resolve(packagingDirectory, '../..')
const repositoryDirectory = executorDirectory
const outputDirectory = resolve(repositoryDirectory, 'dist')
const stagingDirectory = join(outputDirectory, 'nessie-executor-macos')
const buildDirectory = join(outputDirectory, 'nessie-executor-macos-app')

const requireMacOs = () => {
  if (process.platform !== 'darwin') {
    throw new Error(
      'The Nessie Executor DMG is built on macOS. It needs Xcode\'s command line tools to build '
      + 'and sign the menu bar app, hdiutil to make the image, and notarytool to have Apple vouch '
      + `for it. This host is ${process.platform}. Everything that can be checked anywhere is in `
      + 'executor/packaging/macos/dmg-plan.test.mjs.',
    )
  }
}

const exists = async (path) => {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The app's build contract, honoured exactly: the script takes a configuration
 * and an output directory, and prints the absolute path of the built `.app` as
 * the last line of its stdout. A script that prints something else has broken
 * that contract and is told so here, rather than leaving a later step to fail on
 * a path that was never a path.
 */
const buildApp = async () => {
  const scriptPath = resolve(repositoryDirectory, BUILD_APP_SCRIPT)
  if (!await exists(scriptPath)) throw new Error(missingBuildScriptMessage(scriptPath))
  const { stdout } = await run(scriptPath, [
    '--configuration', 'Release',
    '--output', buildDirectory,
  ], { cwd: repositoryDirectory, maxBuffer: 64 * 1024 * 1024 })
  process.stdout.write(stdout)
  const lastLine = stdout.split('\n').map((line) => line.trim()).filter(Boolean).at(-1)
  if (lastLine === undefined || !lastLine.startsWith('/') || !lastLine.endsWith('.app')) {
    throw new Error(
      `${BUILD_APP_SCRIPT} must print the absolute path of the built .app as the last line of its `
      + `stdout. It printed ${lastLine === undefined ? 'nothing' : `"${lastLine}"`}.`,
    )
  }
  if (!await exists(lastLine)) {
    throw new Error(`${BUILD_APP_SCRIPT} named ${lastLine}, which does not exist.`)
  }
  return lastLine
}

const plistValue = async (appPath, key) => {
  const { stdout } = await run('/usr/libexec/PlistBuddy', [
    '-c', `Print :${key}`,
    join(appPath, 'Contents/Info.plist'),
  ])
  return stdout.trim()
}



/**
 * The packaged runtime, laid into the app by its one producer. The pinned Node,
 * the bundled CLI, its licence and the sha256 manifest are never reconstructed
 * here: the desktop bundle, the Linux package and this installer are three
 * callers of one preparation.
 */
const embedExecutorRuntime = async (appPath) => prepareMacExecutorRuntime(repositoryDirectory,
  join(appPath, EXECUTOR_RUNTIME_DIRECTORY))

const sha256File = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')



/**
 * The drag-to-Applications layout: the app, and a symlink to /Applications
 * beside it. That is the gesture every Mac user already knows, and it is what
 * gets the installed copy out of Downloads — where a quarantined app behaves
 * differently from the same app in /Applications.
 *
 * `ditto` rather than a file copy: it is the only macOS copy that preserves the
 * extended attributes and hard links a signed bundle's seal is computed over.
 */
const stageImage = async (appPath) => {
  await rm(stagingDirectory, { force: true, recursive: true })
  await mkdir(stagingDirectory, { recursive: true })
  await run('ditto', [appPath, join(stagingDirectory, basename(appPath))])
  await symlink(APPLICATIONS_SYMLINK_TARGET, join(stagingDirectory, APPLICATIONS_SYMLINK_NAME))
}


requireMacOs()

// Decided before anything is built: a missing certificate is a first-second
// failure, not a surprise after a long compile.
const mode = resolveBuildMode(process.env, {
  requireSigned: process.argv.includes('--require-signed'),
})

await mkdir(outputDirectory, { recursive: true })
await rm(buildDirectory, { force: true, recursive: true })
await mkdir(buildDirectory, { recursive: true })

const appPath = await buildApp()
assertBundleIdentifier(await plistValue(appPath, 'CFBundleIdentifier'))
const version = resolveDmgVersion({
  bundleVersion: await plistValue(appPath, 'CFBundleShortVersionString'),
  declared: process.env.NESSIE_EXECUTOR_VERSION,
})
const name = dmgFileName(version, process.arch, mode.kind)
const packagePath = join(outputDirectory, name)

const runtime = await embedExecutorRuntime(appPath)

if (mode.kind === 'release') {
  await signMacApp(appPath, mode, runtime)
  await notarizeAndStaple(appPath, mode.notary)
  await run('spctl', gatekeeperAssessArguments(appPath, 'exec'))
} else {
  // Exercise the complete custody layout; native publisher checks still reject
  // these unsigned development bytes, so this never establishes eligibility.
  await finishMacManagedManifest(runtime)
}

await stageImage(appPath)
await run('hdiutil', hdiutilArguments({
  output: packagePath,
  sourceDirectory: stagingDirectory,
  volumeName: dmgVolumeName(version, mode.kind),
}))
await rm(stagingDirectory, { force: true, recursive: true })

if (mode.kind === 'release') {
  await run('codesign', codesignArguments({ identity: mode.identity, path: packagePath }))
  await notarizeAndStaple(packagePath, mode.notary)
  await run('spctl', gatekeeperAssessArguments(packagePath, 'open'))
}

await writeFile(`${packagePath}.sha256`, `${await sha256File(packagePath)}  ${name}\n`, {
  mode: 0o644,
})

if (mode.kind === 'development') {
  process.stderr.write(
    `\n${DEVELOPMENT_MARKER}\n`
    + 'This image carries no Developer ID Application signature and no notarization ticket. macOS '
    + 'will refuse to open the app inside it, and this artifact must never be uploaded to a '
    + 'release, sent to anyone, or described as an installer. It exists so the pipeline can be '
    + `exercised on a machine with no certificate. Missing: ${mode.missing.join(', ')}.\n\n`,
  )
}

process.stdout.write(`${packagePath}\n${packagePath}.sha256\n`)
