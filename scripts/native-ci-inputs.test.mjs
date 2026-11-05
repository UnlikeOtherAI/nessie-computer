import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { nativeCiInputs } from './native-ci-inputs.mjs'

const empty = { helper: false, windows: false, vm: false, guest: false, macos_app: false, macos_tests: false }
test('documentation and JavaScript test changes do not build native applications', () => {
  assert.deepEqual(nativeCiInputs(['README.md', 'docs/automatic-updates.md', 'test/updates-state.test.ts'], () => null, () => null), empty)
})
test('Windows service changes leave the Mac app and VM untouched', () => {
  assert.deepEqual(nativeCiInputs(['service-windows/src/main.rs'], () => null, () => null), { ...empty, windows: true })
})
test('the shared installed runtime and its native helper select their actual app consumers', () => {
  assert.deepEqual(nativeCiInputs(['src/daemon-server.ts'], () => null, () => null),
    { ...empty, windows: true, macos_app: true, macos_tests: true })
  assert.deepEqual(nativeCiInputs(['native/src/main.rs'], () => null, () => null),
    { ...empty, helper: true, windows: true, macos_app: true, macos_tests: true })
})
test('test commands and audited artwork/lint tools do not select native applications', () => {
  const original = JSON.stringify({ name: '@nessie/executor', scripts: { build: 'tsc', test: 'old' },
    devDependencies: { eslint: '1', sharp: '1' } })
  const changed = JSON.stringify({ name: '@nessie/executor', scripts: { build: 'tsc', test: 'new' },
    devDependencies: { eslint: '2', sharp: '2' } })
  assert.deepEqual(nativeCiInputs(['package.json'], () => original, () => changed), empty)
  const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
  const lintOnly = lock.replace(/(eslint:\n\s+specifier: [^\n]+\n\s+version: )[^\n]+/u, '$199.0.0')
    .replaceAll('eslint@10.2.0', 'eslint@99.0.0')
  assert.deepEqual(nativeCiInputs(['pnpm-lock.yaml'], () => lock, () => lintOnly), empty)
  assert.deepEqual(nativeCiInputs(['package.json'], () => original, () => original.replace('tsc', 'new-compiler')),
    { ...empty, windows: true, macos_app: true, macos_tests: true })
})

test('Windows-only build tools leave Mac bundles unchanged, while runtime resolutions rebuild their consumers', () => {
  const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
  const cliVersion = /'@tauri-apps\/cli':\n\s+specifier: [^\n]+\n\s+version: ([^\n]+)/u.exec(lock)?.[1]
  assert.ok(cliVersion, 'the public lockfile declares its Windows CLI tool')
  const tauri = lock.replaceAll(cliVersion, '99.0.0')
  assert.deepEqual(nativeCiInputs(['pnpm-lock.yaml'], () => lock, () => tauri), { ...empty, windows: true })
  const runtime = lock.replaceAll('3.25.76', '3.25.77')
  assert.deepEqual(nativeCiInputs(['pnpm-lock.yaml'], () => lock, () => runtime),
    { ...empty, windows: true, macos_app: true, macos_tests: true })
})
