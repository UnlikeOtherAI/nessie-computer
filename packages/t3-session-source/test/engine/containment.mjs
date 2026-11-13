import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = realpathSync(dirname(fileURLToPath(import.meta.url)))
const prefix = `${root.toLowerCase()}${sep}`
const modules = new Set()
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context)
  if (result.url.startsWith('file:')) {
    const path = realpathSync(fileURLToPath(result.url))
    assert.ok(path.toLowerCase().startsWith(prefix), `Consumer module escaped its own installation: ${path}`)
    modules.add(path)
  } else assert.ok(result.url.startsWith('node:') || result.url.startsWith('data:'), result.url)
  return result
} })
process.once('exit', () => console.log(JSON.stringify({ consumerModuleContainment: true,
  consumerRoot: root, moduleFiles: modules.size })))
