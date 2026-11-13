import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const parent = resolve(root, '.artifacts/contract-declarations')
await mkdir(parent, { recursive: true })
const output = await mkdtemp(resolve(parent, 'run-'))
for (const [script, heap] of [['produce.mjs', 5120], ['check-composite.mjs', 512]]) {
  const result = spawnSync(process.execPath,
    [`--max-old-space-size=${heap}`, resolve(import.meta.dirname, script), output],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  process.stdout.write(result.stdout)
}
