import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('normal subpath consumer retains the exact SDK Query and refuses generic input', () => {
  const require = createRequire(new URL('../../../../packaging/session-engine/package.json', import.meta.url))
  const result = spawnSync(process.execPath, ['--max-old-space-size=5120', require.resolve('typescript/bin/tsc'),
    '--strict', '--skipLibCheck', 'false', '--target', 'ES2024', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--types', 'node', '--exactOptionalPropertyTypes',
    '--noUncheckedIndexedAccess', '--noEmit', fileURLToPath(new URL('./consumer.mts', import.meta.url))],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
