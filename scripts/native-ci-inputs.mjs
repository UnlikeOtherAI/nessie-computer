import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXECUTOR_DEVELOPMENT_ONLY_DEPENDENCIES, lockDependencySnapshot } from './native-lockfile.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)])) : value
const testing = file => /(?:^|\/)(?:test|tests|__tests__|fixtures|e2e)\/|\.(?:test|spec)\.[^/]+$/u.test(file)
const documentation = file => /(?:^|\/)(?:docs|archive|memory)\/|\.md$/u.test(file)

const packageInputs = source => {
  const value = JSON.parse(source)
  const { scripts = {}, devDependencies = {} } = value
  const fields = Object.fromEntries(['name', 'version', 'type', 'main', 'module', 'types', 'exports', 'imports',
    'bin', 'dependencies', 'optionalDependencies', 'peerDependencies', 'engines', 'os', 'cpu', 'packageManager']
    .filter(name => name in value).map(name => [name, value[name]]))
  return canonical({ ...fields,
    devDependencies: Object.fromEntries(Object.entries(devDependencies)
      .filter(([name]) => !EXECUTOR_DEVELOPMENT_ONLY_DEPENDENCIES.includes(name))),
    scripts: Object.fromEntries(Object.entries(scripts).filter(([name]) => /^(?:build|prepare|preinstall|install|postinstall)(?::|$)/u.test(name))),
  })
}

export function nativeCiInputs(files, before, after) {
  let runtime = false, helper = false, helperPayload = false, windows = false, vm = false, guest = false, macosApp = false
  let macosTests = false
  let updater = false
  let linuxHelper = false
  for (const file of files) {
    if (documentation(file)) continue
    linuxHelper ||= file.startsWith('packaging/linux/keys/')
    updater ||= file.startsWith('updater/')
    helper ||= file.startsWith('native/') || file === 'src/t3-session/source/tables.json'
    const windowsPath = /^(?:windows-common|windows-provenance|service-windows|tray-windows)\//u.test(file)
    windows ||= windowsPath && !file.endsWith('package.json')
    vm ||= file.startsWith('vm/')
    guest ||= file.startsWith('guest/')
    macosTests ||= file.startsWith('menubar-macos/')
    if (testing(file) || /(?:^|\/)turbo\.[^/]+$/u.test(file)) continue
    // The updater is linked into the native helper and shipped by each app.
    helper ||= file.startsWith('updater/')
    helperPayload ||= file.startsWith('updater/')
    if (file.endsWith('package.json')) {
      try { if (JSON.stringify(packageInputs(before(file))) === JSON.stringify(packageInputs(after(file)))) continue }
      catch { /* An unknown build configuration selects verification. */ }
    }
    windows ||= windowsPath
    helperPayload ||= file.startsWith('native/') || file === 'src/t3-session/source/tables.json'
    if (file === 'pnpm-lock.yaml') {
      const ignored = { '.': EXECUTOR_DEVELOPMENT_ONLY_DEPENDENCIES }
      const changed = roots => {
        const old = lockDependencySnapshot(before(file), roots, ignored)
        const current = lockDependencySnapshot(after(file), roots, ignored)
        return old === null || current === null || old !== current
      }
      runtime ||= changed([{ directory: '.' }])
      windows ||= changed([{ directory: '.' }, { directory: 'tray-windows' }])
      continue
    }
    runtime ||= /^(?:src|packages|scripts)\//u.test(file) && !file.startsWith('scripts/native-')
      || ['package.json', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.build.json'].includes(file)
    windows ||= file.startsWith('packaging/windows/')
    macosApp ||= file.startsWith('menubar-macos/') || file.startsWith('packaging/macos/') || file === '.swiftlint.yml'
  }
  macosApp ||= helperPayload || runtime
  return { helper, linux_helper: linuxHelper, updater, windows: windows || helperPayload || runtime, vm, guest, macos_app: macosApp,
    macos_tests: macosTests || macosApp }
}

function main() {
  let flags
  try {
    const base = process.env.GITHUB_REF_NAME === 'main' ? process.env.NESSIE_NATIVE_BASE : 'origin/main'
    if (!base || /^0+$/u.test(base)) throw new Error('No verified comparison source')
    const files = git(['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean)
    const read = revision => file => { try { return git(['show', `${revision}:${file}`]) } catch { return null } }
    flags = nativeCiInputs(files, read(base), read('HEAD'))
  } catch {
    flags = { helper: true, updater: true, windows: true, vm: true, guest: true, macos_app: true, macos_tests: true }
    process.stdout.write('Native comparison unavailable; checking the complete native source.\n')
  }
  const output = Object.entries(flags).map(([name, enabled]) => `${name}=${enabled ? '1' : '0'}\n`).join('')
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  process.stdout.write(output)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
