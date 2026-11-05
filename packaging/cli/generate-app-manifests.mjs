// Local preparation only: this writes manifests and never publishes or submits them.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { appCask, stableAppTag, wingetManifests } from './app-manifests.mjs'
import { assertDeveloperIdSignature } from '../macos/dmg-plan.mjs'

const run = promisify(execFile)
const [kind, declaredTag, input, destination = 'dist/package-manifests'] = process.argv.slice(2)
const tag = stableAppTag(declaredTag)
if (!input) throw new Error('Provide the signed installer path.')
const file = resolve(input)
const output = resolve(destination)
const sha256 = createHash('sha256').update(await readFile(file)).digest('hex')

if (kind === 'desktop' || kind === 'executor') {
  if (process.platform !== 'darwin') throw new Error('Verify and generate Homebrew casks on macOS.')
  const team = process.env.NESSIE_DESKTOP_SIGNING_TEAM_ID
  if (!team) throw new Error('Set the trusted Developer ID team.')
  const expected = kind === 'desktop' ? 'Nessie-macOS-Apple-Silicon.dmg' : 'Nessie-Executor-macOS-Apple-Silicon.dmg'
  if (basename(file) !== expected) throw new Error(`Use the release asset name: ${expected}`)
  await run('codesign', ['--verify', '--deep', '--strict', file])
  assertDeveloperIdSignature((await run('codesign', ['-dvv', file])).stderr, team)
  await run('xcrun', ['stapler', 'validate', file])
  await run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', file])
  const mount = await mkdtemp(join(tmpdir(), 'nessie-cask-'))
  await run('hdiutil', ['attach', file, '-nobrowse', '-readonly', '-mountpoint', mount])
  try {
    const name = kind === 'desktop' ? 'Nessie' : 'Nessie Executor'
    const app = join(mount, `${name}.app`)
    await run('codesign', ['--verify', '--deep', '--strict', app])
    assertDeveloperIdSignature((await run('codesign', ['-dvv', app])).stderr, team)
    await run('spctl', ['--assess', '--type', 'execute', app])
    const { stdout } = await run('/usr/libexec/PlistBuddy', [
      '-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist'),
    ])
    const directory = join(output, 'Casks')
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${kind === 'desktop' ? 'nessie' : 'nessie-executor-app'}.rb`)
    await writeFile(path, appCask({ app: kind, version: stdout.trim(), tag, sha256 }))
    process.stdout.write(`${path}\n`)
  } finally {
    await run('hdiutil', ['detach', mount])
    await rmdir(mount)
  }
} else if (kind === 'winget') {
  if (process.platform !== 'win32') throw new Error('Verify and generate WinGet manifests on Windows.')
  if (basename(file) !== 'Nessie-Executor-Windows.msi') throw new Error('Use the stable release asset name Nessie-Executor-Windows.msi.')
  const { stdout } = await run('pwsh', ['-NoProfile', '-File',
    fileURLToPath(new URL('./inspect-windows-installer.ps1', import.meta.url)), '-Path', file])
  const facts = JSON.parse(stdout.replace(/^\uFEFF/, ''))
  const directory = join(output, 'manifests/u/UnlikeOtherAI/NessieExecutor', facts.version)
  await mkdir(directory, { recursive: true })
  for (const [name, contents] of Object.entries(wingetManifests({ ...facts, tag, sha256 }))) {
    await writeFile(join(directory, name), contents)
  }
  process.stdout.write(`${directory}\n`)
} else throw new Error('Choose desktop, executor or winget.')
