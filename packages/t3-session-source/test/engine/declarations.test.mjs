import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'

test('ordinary NodeNext composite consumers emit declarations without compiling dependency implementations', () => {
  const root = resolve(import.meta.dirname, '../..')
  const result = spawnSync(process.execPath, ['--max-old-space-size=512',
    resolve(import.meta.dirname, '../declarations/check-composite.mjs'), root],
  { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  process.stdout.write(result.stdout)
})
