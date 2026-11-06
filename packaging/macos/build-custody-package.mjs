// Build a separate root-owned custody package; this command never installs it.
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { resolveBuildMode } from './dmg-plan.mjs'
import { stageMacManagedRelease } from './managed-release.mjs'
import { notarizeAndStaple } from './sign-app.mjs'

if (process.platform !== 'darwin') throw new Error('Build the custody package on macOS.')
const [runtimeDirectory, outputDirectory, version, applicationDirectory] = process.argv.slice(2)
if (!runtimeDirectory || !outputDirectory || !/^\d+\.\d+\.\d+$/u.test(version ?? '')) {
  throw new Error('Provide a prepared runtime, output directory and numeric release version.')
}
const mode = resolveBuildMode(process.env, { requireSigned: process.argv.includes('--require-signed') })
if (mode.kind === 'release' && (!applicationDirectory || applicationDirectory.startsWith('--'))) {
  throw new Error('A release custody package requires its signed Nessie Executor.app as the fourth argument.')
}
const installerIdentity = process.env.NESSIE_EXECUTOR_INSTALLER_SIGNING_IDENTITY
if (mode.kind === 'release' && (!installerIdentity?.startsWith('Developer ID Installer: ')
  || !installerIdentity.endsWith(`(${mode.teamId})`))) throw new Error('A matching Developer ID Installer identity is required.')
const run = promisify(execFile), output = resolve(outputDirectory)
const manifestBytes = await readFile(join(resolve(runtimeDirectory), 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
if (manifest.executorVersion !== version || !/^[a-f0-9]{40}$/u.test(manifest.executorSourceCommit ?? '')) {
  throw new Error('The prepared runtime must record the exact package version and source revision.')
}
if (mode.kind === 'release') {
  const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${mode.teamId}"`
    + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
  for (const name of ['nessie-executor-native', 'nessie-executor-runtime']) {
    await run('/usr/bin/codesign', ['--verify', '--strict', '-R', `=${requirement}`, join(resolve(runtimeDirectory), name)])
  }
  const application = resolve(applicationDirectory)
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=${requirement}`, application])
  for (const [key, expected] of [['CFBundleIdentifier', 'com.unlikeotherai.nessie.executor.menubar'],
    ['CFBundleShortVersionString', version], ['NessieExecutorManagedLaunchProtocol', '1'],
    ['NessieExecutorPersonalInferenceGuardVersion', '2'], ['NessieExecutorIndependentRuntime', '1']]) {
    const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(application, 'Contents/Info.plist')])
    if (stdout.trim() !== expected) throw new Error(`The signed application has an incompatible ${key}.`)
  }
  const embedded = await readFile(join(application, 'Contents/Resources/executor-runtime/manifest.json'))
  if (!embedded.equals(manifestBytes)) throw new Error('The app and protected runtime must carry the same signed release.')
}
await mkdir(output, { recursive: true })
const candidate = await stageMacManagedRelease(resolve(runtimeDirectory), join(output, 'custody-payload'),
  join(output, 'custody-scripts'))
if (applicationDirectory && !applicationDirectory.startsWith('--')) {
  await mkdir(join(output, 'custody-payload/Applications'), { recursive: true })
  await run('/usr/bin/ditto', [resolve(applicationDirectory), join(output, 'custody-payload/Applications/Nessie Executor.app')])
}
const unsigned = join(output, `NessieExecutorCustody_${version}_${candidate.releaseDigest.slice(0, 12)}`
  + '-UNSIGNED-DEVELOPMENT-DO-NOT-INSTALL.pkg')
await run('/usr/bin/pkgbuild', ['--root', join(output, 'custody-payload'), '--ownership', 'recommended',
  '--identifier', 'com.unlikeotherai.nessie.executor.custody', '--version', version, '--install-location', '/',
  '--scripts', join(output, 'custody-scripts'), unsigned], { maxBuffer: 16 * 1024 * 1024 })
if (mode.kind === 'release') {
  const signed = join(output, `NessieExecutorCustody_${version}.pkg`)
  await run('/usr/bin/productsign', ['--sign', installerIdentity, unsigned, signed])
  const checked = await run('/usr/sbin/pkgutil', ['--check-signature', signed])
  if (!checked.stdout.includes('Developer ID Installer: ') || !checked.stdout.includes(`(${mode.teamId})`)) {
    throw new Error('The custody package does not carry the expected Installer publisher.')
  }
  await notarizeAndStaple(signed, mode.notary)
  await run('/usr/sbin/spctl', ['--assess', '--type', 'install', '--verbose=2', signed])
  process.stdout.write(`${signed}\n`)
} else process.stdout.write(`${unsigned}\nUnsigned custody candidate: do not install or publish.\n`)
