#!/usr/bin/env node
// Windows state checks need the real native ACL helper beside the test runtime.
// Keep source Node unmarked: ACL verification does not establish an installed
// runtime or activate the installed-only custody and update paths.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const options = args.filter(argument => /^--test-(?:name-pattern|concurrency)=/u.test(argument))
const files = args.filter(argument => !options.includes(argument))
let node = process.execPath
const env = { ...process.env }

if (process.platform === 'win32') {
  const release = join(root, 'native/target/release')
  if (!existsSync(join(release, 'nessie-executor-native.exe'))) {
    console.error('Windows unit tests require the native ACL helper. Run cargo build --release --manifest-path native/Cargo.toml.')
    process.exit(2)
  }
  node = join(release, 'node.exe')
  const version = existsSync(node) ? spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout?.trim() : undefined
  if (version !== process.version) copyFileSync(process.execPath, node)
  delete env.NESSIE_EXECUTOR_PACKAGED_CLI
}

const result = spawnSync(node, [
  '--test', '--test-concurrency=2', ...options, '--test-force-exit', '--import', 'tsx', ...files,
], { cwd: root, env, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
