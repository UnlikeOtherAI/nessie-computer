import { createHash } from 'node:crypto'
import { access, constants, cp, chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const executorDirectory = resolve(scriptDirectory, '..')
const extensionSourceDirectory = resolve(executorDirectory, 'chrome-extension')
const nativeHostName = 'works.nessie.executor.browser_import'
const extensionIdPattern = /^[a-p]{32}$/

const usage = () => {
  throw new Error(
    'Usage: prepare-chrome-cookie-import --mode development --output <absolute-dir> '
    + '--state-root <absolute-owner-only-dir> --executor-node <absolute-node> '
    + '--executor-entry <absolute-built-index.js> --extension-public-key <base64-der-file>\n'
    + '   or: prepare-chrome-cookie-import --mode release --output <absolute-dir> '
    + '--state-root <absolute-owner-only-dir> --extension-id <Chrome-Web-Store-id> '
    + '--signed-launcher <absolute-signed-launcher>',
  )
}

const valueFor = (args, flag) => {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) usage()
  return value
}

const optionalValueFor = (args, flag) => args.includes(flag) ? valueFor(args, flag) : undefined

const requiredAbsolutePath = (value, label) => {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`)
  return resolve(value)
}

export const chromeExtensionIdForPublicKey = (encodedKey) => {
  const key = Buffer.from(encodedKey.trim(), 'base64')
  if (key.length === 0) throw new Error('The Chrome development public key is empty.')
  return [...createHash('sha256').update(key).digest().subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .split('')
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(nibble, 16)))
    .join('')
}

const assertOrdinaryFile = async (path, label) => {
  const entry = await lstat(path).catch(() => undefined)
  if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error(`${label} is not an ordinary file.`)
}

const assertExecutableFile = async (path, label) => {
  await assertOrdinaryFile(path, label)
  await access(path, constants.X_OK).catch(() => {
    throw new Error(`${label} is not executable.`)
  })
}

const run = async (program, arguments_) => new Promise((resolvePromise, reject) => {
  const child = spawn(program, arguments_, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.once('error', () => reject(new Error(`Could not start ${program}.`)))
  child.once('close', (code) => {
    if (code === 0) resolvePromise(stderr)
    else reject(new Error(`${program} rejected the signed native-host launcher: ${stderr}`))
  })
})

const verifyMacReleaseLauncher = async (path) => {
  const teamId = process.env.NESSIE_DESKTOP_SIGNING_TEAM_ID
  if (!teamId) throw new Error('NESSIE_DESKTOP_SIGNING_TEAM_ID is required for release native-host packaging.')
  await run('/usr/bin/codesign', ['--verify', '--strict', path])
  const details = await run('/usr/bin/codesign', ['-dvvv', path])
  if (!details.includes('Authority=Developer ID Application:') || !details.includes(`TeamIdentifier=${teamId}`)) {
    throw new Error('The native-host launcher is not signed by the configured Developer ID team.')
  }
}

const quoted = (value) => `'${value.replaceAll("'", "'\\''")}'`

const writeDevelopmentLauncher = async ({ executorEntry, executorNode, extensionId, launcherPath, stateRoot }) => {
  await assertExecutableFile(executorNode, 'The development Node runtime')
  await assertOrdinaryFile(executorEntry, 'The built executor entry point')
  const origin = `chrome-extension://${extensionId}/`
  const launcher = [
    '#!/bin/sh',
    'set -eu',
    `exec ${quoted(executorNode)} ${quoted(executorEntry)} native-browser-cookie-import `
      + `--development-local-api --state-root ${quoted(stateRoot)} `
      + `--extension-origin ${quoted(origin)} --caller-origin ${quoted(origin)}`,
    '',
  ].join('\n')
  await writeFile(launcherPath, launcher, { mode: 0o700 })
  await chmod(launcherPath, 0o700)
}

const zipDirectory = async (directory, outputPath) => new Promise((resolvePromise, reject) => {
  const child = spawn('/usr/bin/zip', ['-X', '-r', outputPath, '.'], {
    cwd: directory,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let error = ''
  child.stderr.on('data', (chunk) => { error += String(chunk) })
  child.once('error', () => reject(new Error(`Could not start macOS zip: ${error}`)))
  child.once('close', (code) => {
    if (code === 0) resolvePromise()
    else reject(new Error(`macOS zip failed while preparing the extension: ${error}`))
  })
})

export const prepareChromeCookieImport = async (options) => {
  const outputDirectory = requiredAbsolutePath(options.outputDirectory, 'The output directory')
  const stateRoot = requiredAbsolutePath(options.stateRoot, 'The executor state root')
  if (options.mode !== 'development' && options.mode !== 'release') {
    throw new Error('Chrome import packaging mode must be development or release.')
  }

  let extensionId
  let launcherPath
  let developmentKey
  let executorEntry
  let executorNode
  if (options.mode === 'development') {
    const publicKeyPath = requiredAbsolutePath(options.extensionPublicKeyPath, 'The development public key path')
    developmentKey = (await readFile(publicKeyPath, 'utf8')).trim()
    extensionId = chromeExtensionIdForPublicKey(developmentKey)
    executorEntry = requiredAbsolutePath(options.executorEntry, 'The built executor entry point')
    executorNode = requiredAbsolutePath(options.executorNode, 'The development Node runtime')
    await Promise.all([
      assertOrdinaryFile(executorEntry, 'The built executor entry point'),
      assertExecutableFile(executorNode, 'The development Node runtime'),
    ])
    launcherPath = join(outputDirectory, 'nessie-executor-browser-host')
  } else {
    extensionId = options.extensionId
    if (!extensionIdPattern.test(extensionId ?? '')) {
      throw new Error('A Chrome Web Store extension id is required for release packaging.')
    }
    launcherPath = requiredAbsolutePath(options.signedLauncherPath, 'The signed native-host launcher')
    await assertExecutableFile(launcherPath, 'The signed native-host launcher')
    await verifyMacReleaseLauncher(launcherPath)
  }

  await rm(outputDirectory, { force: true, recursive: true })
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  const extensionDirectory = join(outputDirectory, 'extension')
  await cp(extensionSourceDirectory, extensionDirectory, { recursive: true })
  const manifestPath = join(extensionDirectory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (options.mode === 'development') {
    manifest.key = developmentKey
    manifest.name = 'Nessie Chrome Import (Development)'
    manifest.description = 'Development-only selected-site sign-in import for a local Nessie executor.'
  } else {
    delete manifest.key
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })

  if (options.mode === 'development') {
    await writeDevelopmentLauncher({
      executorEntry,
      executorNode,
      extensionId,
      launcherPath,
      stateRoot,
    })
  }

  const origin = `chrome-extension://${extensionId}/`
  const nativeHostDirectory = join(outputDirectory, 'native-host')
  await mkdir(nativeHostDirectory, { recursive: true, mode: 0o700 })
  const nativeHostManifestPath = join(nativeHostDirectory, `${nativeHostName}.json`)
  await writeFile(nativeHostManifestPath, `${JSON.stringify({
    allowed_origins: [origin],
    description: 'Nessie selected-site browser cookie import bridge',
    name: nativeHostName,
    path: launcherPath,
    type: 'stdio',
  }, null, 2)}\n`, { mode: 0o600 })

  const extensionZipPath = join(outputDirectory, 'nessie-chrome-cookie-import.zip')
  await zipDirectory(extensionDirectory, extensionZipPath)
  await writeFile(join(outputDirectory, 'configuration.json'), `${JSON.stringify({
    extensionId,
    extensionZipPath,
    mode: options.mode,
    nativeHostManifestPath,
    nativeHostName,
  }, null, 2)}\n`, { mode: 0o600 })
  return { extensionDirectory, extensionId, extensionZipPath, launcherPath, nativeHostManifestPath }
}

const main = async () => {
  const args = process.argv.slice(2)
  const mode = valueFor(args, '--mode')
  const result = await prepareChromeCookieImport({
    executorEntry: optionalValueFor(args, '--executor-entry'),
    executorNode: optionalValueFor(args, '--executor-node'),
    extensionId: optionalValueFor(args, '--extension-id'),
    extensionPublicKeyPath: optionalValueFor(args, '--extension-public-key'),
    mode,
    outputDirectory: valueFor(args, '--output'),
    signedLauncherPath: optionalValueFor(args, '--signed-launcher'),
    stateRoot: valueFor(args, '--state-root'),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
