// Shared inside-out Developer ID signing for the executor and desktop apps.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  APP_ENTITLEMENTS_FILE, RUNTIME_ENTITLEMENTS_FILE, assertDeveloperIdSignature,
  codesignArguments, codesignVerifyArguments, notarizeArguments, stapleArguments,
} from './dmg-plan.mjs'
import { finishMacManagedManifest } from './managed-release.mjs'

const run = promisify(execFile)
const packagingDirectory = dirname(fileURLToPath(import.meta.url))
const sha256File = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
const plistValue = async (app, key) => (await run('/usr/libexec/PlistBuddy', [
  '-c', `Print :${key}`, join(app, 'Contents/Info.plist'),
])).stdout.trim()

const nestedSigningTargets = async (appPath, mainExecutable) => {
  const { stdout } = await run('/usr/bin/find', [appPath, '-type', 'f', '-o', '-type', 'd', '-name', '*.framework'])
  const candidates = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  const binaries = []
  for (const path of candidates) {
    if (path === mainExecutable) continue
    // A framework is a resource-bearing bundle. Signing only its Mach-O leaves
    // its existing resource seal invalid after the executable is replaced.
    if (path.endsWith('.framework')) { binaries.push(path); continue }
    const { stdout: kind } = await run('/usr/bin/file', ['--brief', '--mime-type', path])
    if (kind.trim() === 'application/x-mach-binary') binaries.push(path)
  }
  // Deepest first, so a nested binary is always sealed before whatever contains
  // it: signing a child after its parent silently breaks the parent.
  return binaries.sort((left, right) => right.split('/').length - left.split('/').length)
}

export const signMacApp = async (appPath, { identity, teamId }, runtime) => {
  const appEntitlements = join(packagingDirectory, APP_ENTITLEMENTS_FILE)
  const runtimeEntitlements = join(packagingDirectory, RUNTIME_ENTITLEMENTS_FILE)
  const mainExecutable = join(appPath, 'Contents/MacOS', await plistValue(appPath, 'CFBundleExecutable'))

  for (const path of await nestedSigningTargets(appPath, mainExecutable)) {
    await run('codesign', codesignArguments({
      entitlements: path.endsWith('.framework') ? undefined
        : path === runtime.nodePath ? runtimeEntitlements : appEntitlements,
      identity,
      path,
    }))
  }

  if (runtime.manifest.nativeHelper === 'nessie-executor-native') await finishMacManagedManifest(runtime)
  else await writeFile(
    runtime.manifestPath,
    `${JSON.stringify({
      ...runtime.manifest,
      executorBundleSha256: await sha256File(runtime.executorBundlePath),
      nodeSha256: await sha256File(runtime.nodePath),
    }, null, 2)}\n`,
    { mode: 0o644 },
  )

  await run('codesign', codesignArguments({ entitlements: appEntitlements, identity, path: appPath }))
  await run('codesign', codesignVerifyArguments(appPath))
  const { stderr } = await run('codesign', ['-dvv', appPath])
  assertDeveloperIdSignature(stderr, teamId)
}

export const notarizeAndStaple = async (path, notary) => {
  process.stdout.write(`Notarizing ${basename(path)} with the ${notary.kind} credential…\n`)
  const submitted = path.endsWith('.app') ? `${path}.notary.zip` : path
  if (submitted !== path) await run('ditto', ['-c', '-k', '--keepParent', path, submitted])
  const { stdout } = await run('xcrun', notarizeArguments(notary, submitted), {
    maxBuffer: 16 * 1024 * 1024,
  })
  process.stdout.write(stdout)
  if (!/status:\s*Accepted/i.test(stdout)) {
    throw new Error(
      `Notarization of ${basename(path)} was not Accepted. Read the log with `
      + '`xcrun notarytool log <submission-id>`. A rejected submission is never stapled, and this '
      + 'artifact must not be published.',
    )
  }
  if (submitted !== path) await rm(submitted)
  await run('xcrun', stapleArguments(path))
  await run('xcrun', ['stapler', 'validate', path])
}
